"use client";

/**
 * The rows of a conversation chat: the agent's messages (named, with a small
 * avatar), people's replies as right-aligned bubbles, system lines, and your
 * own message while it sends or after it failed.
 */

import { Box, ButtonBase, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import type { ConversationMessageContract } from "@scarn/api/frontend-contracts";
import { formatClockTime } from "@/components/executions/format-datetime";
import { Prose } from "@/components/executions/prose";
import { SystemLine, TextLink } from "@/components/executions/thread-parts";
import { UserBubble } from "@/components/executions/user-bubble";
import type { GrantRequestCardContext } from "./grant-request-api";
import { GrantRequestMessageCard } from "./grant-request-card";
import type { LocalConversationMessage } from "./use-conversation";

export function AgentAvatar({ agentName }: { agentName: string }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        fontSize: 13,
        fontWeight: 700,
        backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.18),
        color: "primary.main",
      }}
    >
      {agentName.trim().charAt(0).toUpperCase()}
    </Box>
  );
}

export function ConversationMessage({
  message,
  agentName,
  onShowWork,
  grantRequest = null,
}: {
  message: ConversationMessageContract;
  agentName: string;
  onShowWork: (taskRunId: string) => void;
  grantRequest?: GrantRequestCardContext | null;
}) {
  const time = formatClockTime(message.createdAt);
  if (message.authorKind === "system") {
    return (
      <SystemLine icon="→">
        {message.body}
        {time ? ` · ${time}` : ""}
      </SystemLine>
    );
  }
  if (message.authorKind === "person") {
    return (
      <Stack spacing={0.5} data-testid="conversation-person-message">
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", alignSelf: "flex-end", px: 0.5 }}
        >
          {[message.authorName, time].filter(Boolean).join(" · ")}
        </Typography>
        <UserBubble body={message.body} quote={null} />
      </Stack>
    );
  }
  const { taskRunId } = message;
  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="flex-start"
      data-testid="conversation-agent-message"
    >
      <AgentAvatar agentName={agentName} />
      <Stack spacing={0.75} sx={{ minWidth: 0, flex: 1, pt: 0.5 }}>
        <Typography variant="caption" sx={{ color: "text.disabled" }}>
          {[agentName, time].filter(Boolean).join(" · ")}
        </Typography>
        <Box data-quotable>
          <Prose text={message.body} />
        </Box>
        {message.grantRequestId && grantRequest ? (
          <GrantRequestMessageCard
            grantRequestId={message.grantRequestId}
            taskRunId={taskRunId}
            {...grantRequest}
          />
        ) : null}
        {taskRunId ? (
          <Typography variant="body2" sx={{ color: "text.disabled" }}>
            <TextLink
              onClick={() => {
                onShowWork(taskRunId);
              }}
            >
              Show work
            </TextLink>
          </Typography>
        ) : null}
      </Stack>
    </Stack>
  );
}

/** Your message before the conversation holds it: sending, or failed with a retry. */
export function LocalMessage({
  message,
  onRetry,
}: {
  message: LocalConversationMessage;
  onRetry: () => void;
}) {
  const failed = message.delivery === "failed";
  return (
    <Stack
      spacing={0.5}
      alignItems="flex-end"
      data-testid="conversation-local-message"
      data-delivery={message.delivery}
    >
      <Box
        sx={{
          width: "100%",
          opacity: failed ? 1 : 0.6,
          transition: "opacity 150ms",
        }}
      >
        <UserBubble body={message.body} quote={null} />
      </Box>
      {failed ? (
        <ButtonBase
          onClick={onRetry}
          title={message.error ?? undefined}
          sx={{
            gap: 0.5,
            px: 1,
            py: 0.5,
            borderRadius: 1,
            color: "error.main",
            typography: "caption",
          }}
        >
          <ErrorOutlineIcon sx={{ fontSize: 14 }} />
          Not sent · Tap to retry
        </ButtonBase>
      ) : (
        <Typography variant="caption" sx={{ color: "text.disabled", px: 0.5 }}>
          Sending…
        </Typography>
      )}
    </Stack>
  );
}
