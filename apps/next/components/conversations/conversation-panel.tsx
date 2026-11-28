"use client";

/**
 * A step visit's conversation with the people it waits on, as a chat: what
 * the agent said at the end of each turn, what people replied, and what they
 * did without writing. `ConversationPanel` is the chat and its actions;
 * `ConversationMessageBox` is the reply field pinned under it;
 * `ConversationActions` are the waiting actions on their own, for hosts that
 * show them elsewhere, and `useConversationActions` lists them for hosts that
 * render them their own way (a menu). All read the same `useConversation` data.
 * With `mode="chat"` they show a repo conversation instead: no waiting
 * actions, a status line by its `state`, and a reply box gated by its
 * `capabilities`.
 */

import {
  Alert,
  Box,
  Button,
  IconButton,
  InputBase,
  Stack,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import { useState, type KeyboardEvent } from "react";
import {
  CONVERSATION_MESSAGE_BODY_MAX_LENGTH,
  type ConversationContract,
} from "@scarn/api/frontend-contracts";
import { useHasProjectPermission } from "@/components/project-route-context";
import { ThinkingIndicator } from "@/components/executions/conversation-parts";
import { SystemLine } from "@/components/executions/thread-parts";
import { ChatStatusLine, chatReplyBlockedReason } from "./chat-status";
import {
  AgentAvatar,
  ConversationMessage,
  LocalMessage,
} from "./conversation-messages";
import {
  grantRequestCardContext,
  pendingGrantRequestId,
} from "./grant-request-api";
import type {
  ConversationActionOutcome,
  ConversationData,
} from "./use-conversation";

/** What **Ask it to finish** sends, word for word. */
export const ASK_TO_FINISH_MESSAGE =
  "If you're done, submit your findings now.";

/** Who the chat names as the agent when the host doesn't say. */
export const DEFAULT_AGENT_NAME = "Scarn";

/** A step visit's conversation (`grilling`) or a repo conversation (`chat`). */
export type ConversationPanelMode = "grilling" | "chat";

/** The conversation takes replies: the agent waits, or its next turn is queued. */
export const acceptsReplies = (
  conversation: Pick<ConversationContract, "status"> | null,
): boolean =>
  conversation?.status === "waiting_for_person" ||
  conversation?.status === "reply_pending";

export function ConversationPanel({
  data,
  onShowWork,
  agentName = DEFAULT_AGENT_NAME,
  showActions = true,
  mode = "grilling",
}: {
  data: ConversationData;
  /** Opens the transcript of the attempt that wrote an agent message. */
  onShowWork: (taskRunId: string) => void;
  agentName?: string;
  /** Off when the host shows `ConversationActions` itself. */
  showActions?: boolean;
  mode?: ConversationPanelMode;
}) {
  const { conversation } = data;
  const isChat = mode === "chat";
  const [actionError, setActionError] = useState("");

  if (!conversation) {
    if (data.error) {
      return <Alert severity="error">{data.error}</Alert>;
    }
    return (
      <Typography variant="body2" color="text.secondary">
        Loading conversation…
      </Typography>
    );
  }

  const report = (outcome: ConversationActionOutcome) => {
    setActionError(outcome.ok ? "" : outcome.error);
  };

  return (
    <Stack spacing={2.5} data-testid="conversation-panel">
      {conversation.messages.map((message) => (
        <ConversationMessage
          key={message.id}
          message={message}
          agentName={agentName}
          onShowWork={onShowWork}
          grantRequest={grantRequestCardContext(
            conversation,
            message.grantRequestId,
            data.refetch,
          )}
        />
      ))}
      {data.localMessages.map((message) => (
        <LocalMessage
          key={message.localId}
          message={message}
          onRetry={() => {
            void data.retry(message.localId);
          }}
        />
      ))}
      {isChat ? (
        <ChatStatusLine conversation={conversation} agentName={agentName} />
      ) : (
        <ConversationStatusLine
          conversation={conversation}
          agentName={agentName}
        />
      )}
      {data.error ? <Alert severity="error">{data.error}</Alert> : null}
      {showActions && !isChat ? (
        <>
          <ConversationActions data={data} onOutcome={report} />
          {actionError ? <Alert severity="error">{actionError}</Alert> : null}
        </>
      ) : null}
    </Stack>
  );
}

function ConversationStatusLine({
  conversation,
  agentName,
}: {
  conversation: ConversationContract;
  agentName: string;
}) {
  switch (conversation.status) {
    case "agent_turn":
      return (
        <Stack direction="row" spacing={1.25} alignItems="center">
          <AgentAvatar agentName={agentName} />
          <Box sx={{ ml: -1.5 }}>
            <ThinkingIndicator label={`${agentName} is thinking…`} />
          </Box>
        </Stack>
      );
    case "reply_pending":
      return (
        <SystemLine icon="↻">
          {agentName} picks up your reply on its next turn. Anything else you
          send before then goes with it.
        </SystemLine>
      );
    case "waiting_for_person":
      return (
        <Typography variant="body2" sx={{ color: "warning.main" }}>
          Waiting for a reply
        </Typography>
      );
    case "closed":
      return <SystemLine icon="✓">This conversation has ended.</SystemLine>;
  }
}

/** One waiting action, for a host to render as a button or a menu item. */
export type ConversationActionItem = {
  key: "ask-to-finish" | "done" | "continue";
  label: string;
  /** Whether it's a primary action (outlined) or a quiet one (text). */
  emphasis: "primary" | "quiet";
  disabled: boolean;
  run: () => Promise<ConversationActionOutcome>;
};

/**
 * The waiting actions the viewer may take while the agent waits: **Ask it
 * to finish** on a step with findings (a fixed reply, `comments:write`),
 * **Done** on a conversation step and **Continue without reply** (both
 * `executions:write`). Empty otherwise.
 */
export function useConversationActions(
  data: ConversationData,
): ConversationActionItem[] {
  const canCreateComments = useHasProjectPermission("comments:write");
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const { conversation } = data;
  if (conversation?.status !== "waiting_for_person") return [];

  const disabled = data.pending !== null;
  const items: ConversationActionItem[] = [];
  if (conversation.endsWith === "findings" && canCreateComments) {
    items.push({
      key: "ask-to-finish",
      label: "Ask it to finish",
      emphasis: "primary",
      disabled,
      run: () => data.send(ASK_TO_FINISH_MESSAGE),
    });
  }
  if (conversation.endsWith === "conversation" && canWriteExecutions) {
    items.push({
      key: "done",
      label: "Done",
      emphasis: "primary",
      disabled,
      run: data.done,
    });
  }
  if (canWriteExecutions) {
    items.push({
      key: "continue",
      label: "Continue without reply",
      emphasis: "quiet",
      disabled,
      run: data.continueWithoutReply,
    });
  }
  return items;
}

/** `useConversationActions` as a row of buttons; renders nothing when empty. */
export function ConversationActions({
  data,
  onOutcome,
}: {
  data: ConversationData;
  onOutcome: (outcome: ConversationActionOutcome) => void;
}) {
  const items = useConversationActions(data);
  if (items.length === 0) return null;
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      {items.map((item) => (
        <Button
          key={item.key}
          variant={item.emphasis === "primary" ? "outlined" : "text"}
          color={item.emphasis === "primary" ? "primary" : "inherit"}
          size="small"
          disabled={item.disabled}
          onClick={() => {
            void item.run().then(onOutcome);
          }}
        >
          {item.label}
        </Button>
      ))}
    </Stack>
  );
}

/**
 * The reply field under the conversation, while it takes replies and the
 * viewer can write (`comments:write`); renders nothing otherwise. On a
 * keyboard-and-mouse device Enter sends and Shift+Enter makes a new line; on
 * touch, return makes a new line and the button sends. Cmd/Ctrl+Enter sends
 * everywhere. The text clears as soon as it's sent: the chat holds it as a
 * local message, with a retry if the send fails.
 */
export function ConversationMessageBox({
  data,
  agentName = DEFAULT_AGENT_NAME,
  autoFocus = false,
  mode = "grilling",
}: {
  data: ConversationData;
  agentName?: string;
  /** Focuses the field when it appears; hosts leave it off on touch screens. */
  autoFocus?: boolean;
  mode?: ConversationPanelMode;
}) {
  const canCreateComments = useHasProjectPermission("comments:write");
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");

  if (mode === "chat") {
    if (!data.conversation) return null;
    const reason = chatReplyBlockedReason(data.conversation);
    if (reason !== null) {
      return (
        <Box
          data-testid="chat-reply-blocked"
          sx={{ pt: 1, pb: "max(12px, env(safe-area-inset-bottom))", px: 2 }}
        >
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {reason}
          </Typography>
        </Box>
      );
    }
  } else if (!canCreateComments || !acceptsReplies(data.conversation)) {
    return null;
  }

  const pending = data.pending !== null;
  const canSend = !pending && body.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setError("");
    setBody("");
    const outcome = await data.send(body);
    if (!outcome.ok) setError(outcome.error);
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const modified = event.metaKey || event.ctrlKey;
    if (!modified && (coarsePointer || event.shiftKey)) return;
    event.preventDefault();
    void send();
  };

  const hint = pendingGrantRequestId(data.conversation)
    ? `${agentName} is asking for more access — a reply leaves that request unanswered`
    : data.conversation?.status === "reply_pending"
      ? `${agentName} is thinking — anything you send joins its next turn`
      : coarsePointer
        ? null
        : "Enter to send · Shift+Enter for a new line";

  return (
    <Box sx={{ pt: 1, pb: "max(12px, env(safe-area-inset-bottom))" }}>
      <Stack
        direction="row"
        alignItems="flex-end"
        sx={{
          pl: 2,
          pr: 0.75,
          py: 0.75,
          borderRadius: "26px",
          border: 1,
          borderColor: "divider",
          backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.05),
          transition: "border-color 120ms",
          "&:focus-within": { borderColor: "text.disabled" },
        }}
      >
        <InputBase
          multiline
          fullWidth
          autoFocus={autoFocus}
          placeholder={`Message ${agentName}…`}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          inputProps={{
            "aria-label": `Message ${agentName}`,
            enterKeyHint: coarsePointer ? "enter" : "send",
            maxLength: CONVERSATION_MESSAGE_BODY_MAX_LENGTH,
          }}
          sx={{
            fontSize: 16,
            lineHeight: 1.5,
            py: 0.75,
            "& textarea": { maxHeight: "40dvh", overflowY: "auto !important" },
          }}
        />
        <IconButton
          aria-label="Send reply"
          disabled={!canSend}
          onClick={() => {
            void send();
          }}
          sx={{
            position: "relative",
            ml: 1,
            mb: 0.125,
            width: 36,
            height: 36,
            flexShrink: 0,
            backgroundColor: "text.primary",
            color: "background.default",
            "&::before": {
              content: '""',
              position: "absolute",
              inset: -4,
            },
            "&:hover": { backgroundColor: "text.secondary" },
            "&.Mui-disabled": {
              backgroundColor: (theme) =>
                alpha(theme.palette.text.primary, 0.08),
              color: "text.disabled",
            },
          }}
        >
          <ArrowUpwardIcon sx={{ fontSize: 20 }} />
        </IconButton>
      </Stack>
      {error ? (
        <Alert severity="error" sx={{ mt: 1, py: 0 }}>
          {error}
        </Alert>
      ) : null}
      <Box sx={{ minHeight: 22, pt: 0.75, px: 2 }}>
        {hint ? (
          <Typography variant="caption" sx={{ color: "text.disabled" }}>
            {hint}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}
