"use client";

/**
 * A repo conversation's page: fills the height below the project tabs, so the
 * transcript scrolls inside it and the message box stays in view, on phones
 * as on desktops. The header names the chat, who started it, its state and
 * the repo commit it reads; a failed turn shows why with a Retry; End and
 * Delete confirm first. Inside a run's page (`framed`), the run header names
 * the chat, its state and who started it, so only the repo line and the
 * actions stay.
 */

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ConversationContract } from "@scarn/api/frontend-contracts";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";
import { useProjectPath } from "@/components/project-route-context";
import {
  ConversationMessageBox,
  ConversationPanel,
} from "@/components/conversations/conversation-panel";
import { ConversationScroller } from "@/components/conversations/conversation-scroller";
import {
  useConversation,
  type ConversationData,
} from "@/components/conversations/use-conversation";
import { RepoConversationStateChip } from "./repo-conversation-state-chip";

/** What the Delete confirmation says, word for word. */
export const DELETE_CONFIRMATION_TEXT =
  "Deleted conversations can't be recovered.";

const SHORT_COMMIT_LENGTH = 12;
const TITLE_MAX_LENGTH = 140;

type Confirming = "end" | "delete" | null;

export function RepoConversationView({
  conversationId,
  pollIntervalsMs,
  framed = false,
}: {
  conversationId: string;
  projectId: string;
  /** Leaves out the back link, title, state and starter, for a run page's frame. */
  framed?: boolean;
  /** Overrides the chat poll intervals (tests). */
  pollIntervalsMs?: { active: number; idle: number };
}) {
  const projectPath = useProjectPath();
  const router = useRouter();
  const data = useConversation(conversationId, {
    ...(pollIntervalsMs ? { chatPollIntervalsMs: pollIntervalsMs } : {}),
  });
  const { conversation } = data;
  const taskId = conversation?.taskId ?? null;

  return (
    <Box
      data-conversation-id={conversationId}
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        width: "100%",
        maxWidth: CONTENT_MAX_WIDTH,
        mx: "auto",
        px: { xs: 1.5, md: 4 },
        py: { xs: 1.5, md: 3 },
      }}
    >
      {framed ? null : (
        <Box sx={{ flexShrink: 0 }}>
          <Button
            component={Link}
            href={`${projectPath("runs")}?whatRan=task`}
            size="small"
            startIcon={<ArrowBackIcon />}
          >
            Runs
          </Button>
        </Box>
      )}
      {data.unavailable ? (
        <Alert severity="info" sx={{ mt: 2 }} data-testid="chat-unavailable">
          {data.error}
        </Alert>
      ) : (
        <>
          {conversation ? (
            <ChatHeader
              data={data}
              conversation={conversation}
              framed={framed}
              onDeleted={() => {
                router.push(projectPath("runs"));
              }}
            />
          ) : null}
          <ConversationScroller data={data} testId="chat-transcript">
            <Box sx={{ py: 2 }}>
              <ConversationPanel
                data={data}
                mode="chat"
                onShowWork={() => {
                  if (taskId) router.push(projectPath("runs", "tasks", taskId));
                }}
              />
              {conversation?.state === "failed" ? (
                <ChatFailure data={data} conversation={conversation} />
              ) : null}
            </Box>
          </ConversationScroller>
          <Box sx={{ flexShrink: 0 }}>
            <ConversationMessageBox data={data} mode="chat" />
          </Box>
        </>
      )}
    </Box>
  );
}

function chatTitle(conversation: ConversationContract): string {
  const first = conversation.messages.find(
    (message) => message.authorKind === "person",
  );
  const text = (first?.body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Conversation";
  return text.length > TITLE_MAX_LENGTH
    ? `${text.slice(0, TITLE_MAX_LENGTH - 1)}…`
    : text;
}

function ChatHeader({
  data,
  conversation,
  framed,
  onDeleted,
}: {
  data: ConversationData;
  conversation: ConversationContract;
  framed: boolean;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [actionError, setActionError] = useState("");
  const capabilities = conversation.capabilities;
  const canEnd =
    Boolean(capabilities?.canEnd) && conversation.state !== "ended";
  const canDelete = Boolean(capabilities?.canDelete);
  const busy = data.pending !== null;

  const confirm = async () => {
    const action = confirming;
    if (action === null) return;
    setActionError("");
    const outcome = action === "end" ? await data.end() : await data.remove();
    setConfirming(null);
    if (!outcome.ok) {
      setActionError(outcome.error);
      return;
    }
    if (action === "delete") onDeleted();
  };

  return (
    <Box
      component="header"
      sx={{
        flexShrink: 0,
        pt: 1,
        pb: 1.5,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="flex-start"
        flexWrap="wrap"
        useFlexGap
      >
        {framed ? (
          <Box
            data-testid="chat-context-bar"
            sx={{ flex: "1 1 240px", minWidth: 0, color: "text.secondary" }}
          >
            {conversation.context ? (
              <ChatContextLine context={conversation.context} />
            ) : null}
          </Box>
        ) : (
          <Typography
            variant="h6"
            component="h1"
            sx={{ flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}
          >
            {chatTitle(conversation)}
          </Typography>
        )}
        <Stack direction="row" spacing={1} alignItems="center">
          {conversation.state && !framed ? (
            <RepoConversationStateChip state={conversation.state} />
          ) : null}
          {canEnd ? (
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              onClick={() => {
                setConfirming("end");
              }}
            >
              End
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              size="small"
              color="error"
              disabled={busy}
              onClick={() => {
                setConfirming("delete");
              }}
            >
              Delete
            </Button>
          ) : null}
        </Stack>
      </Stack>
      {framed ? null : (
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mt: 0.5, color: "text.secondary" }}
        >
          {conversation.creator?.username ? (
            <Typography variant="body2">
              Started by {conversation.creator.username}
            </Typography>
          ) : null}
          {conversation.context ? (
            <ChatContextLine context={conversation.context} />
          ) : null}
        </Stack>
      )}
      {actionError ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {actionError}
        </Alert>
      ) : null}
      <Dialog
        open={confirming !== null}
        onClose={() => {
          if (!busy) setConfirming(null);
        }}
      >
        <DialogTitle>
          {confirming === "delete"
            ? "Delete this conversation?"
            : "End this conversation?"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirming === "delete"
              ? DELETE_CONFIRMATION_TEXT
              : "No one can reply after it ends. It stays readable."}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(null);
            }}
          >
            Cancel
          </Button>
          <Button
            color={confirming === "delete" ? "error" : "primary"}
            variant="contained"
            disabled={busy}
            onClick={() => {
              void confirm();
            }}
          >
            {confirming === "delete"
              ? "Delete conversation"
              : "End conversation"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function repoName(repository: string): string {
  return repository
    .replace(/\.git$/u, "")
    .replace(/^[a-z]+:\/\/[^/]+\//iu, "")
    .replace(/^git@[^:]+:/u, "");
}

function ChatContextLine({
  context,
}: {
  context: NonNullable<ConversationContract["context"]>;
}) {
  const [copied, setCopied] = useState(false);
  const { commit, branch } = context;
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
      data-testid="chat-context"
    >
      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
        {repoName(context.repository)}
      </Typography>
      {commit === null ? (
        <Typography variant="body2" sx={{ color: "text.disabled" }}>
          · Resolved when execution starts
        </Typography>
      ) : (
        <>
          {branch ? <Typography variant="body2">· {branch}</Typography> : null}
          <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
            · {commit.slice(0, SHORT_COMMIT_LENGTH)}
          </Typography>
          <Tooltip title={copied ? "Copied" : "Copy full commit"}>
            <IconButton
              size="small"
              aria-label="Copy full commit"
              onClick={() => {
                void navigator.clipboard.writeText(commit).then(() => {
                  setCopied(true);
                });
              }}
            >
              <ContentCopyIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </>
      )}
    </Stack>
  );
}

function ChatFailure({
  data,
  conversation,
}: {
  data: ConversationData;
  conversation: ConversationContract;
}) {
  const [error, setError] = useState("");
  const canRetry = Boolean(conversation.capabilities?.canRetry);

  const retry = async () => {
    setError("");
    const outcome = await data.retryTurn(conversation.latestRun?.id ?? null);
    if (outcome.ok) return;
    setError(outcome.error);
    if (outcome.status === 409) data.refetch();
  };

  return (
    <Alert
      severity="error"
      data-testid="chat-failure"
      sx={{ mt: 2 }}
      action={
        canRetry ? (
          <Button
            color="inherit"
            size="small"
            disabled={data.pending !== null}
            onClick={() => {
              void retry();
            }}
          >
            Retry
          </Button>
        ) : undefined
      }
    >
      <Typography variant="body2">
        {conversation.error?.message ?? "The last turn failed."}
      </Typography>
      {canRetry ? null : (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          An execution manager can retry
        </Typography>
      )}
      {error ? (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {error}
        </Typography>
      ) : null}
    </Alert>
  );
}
