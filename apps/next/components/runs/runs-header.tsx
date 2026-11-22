"use client";

/**
 * The Runs list's header: the scope's title, an optional subtitle, and for
 * members a **＋ New task** button that opens an inline composer. Sending
 * starts a Task with no work item (`POST /projects/:pid/conversations`) and
 * opens its Task page.
 */

import {
  Alert,
  Box,
  Button,
  IconButton,
  InputBase,
  Stack,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CONVERSATION_MESSAGE_BODY_MAX_LENGTH } from "@scarn/api/frontend-contracts";
import { parseApiError } from "@/app/_lib/api-error";
import {
  useIsProjectMember,
  useProjectPath,
} from "@/components/project-route-context";
import { createRepoConversation } from "@/components/repo-conversations/repo-conversation-api";

// eslint-disable-next-line local/no-unknown-parameter-type
function newTaskError(error: unknown): string {
  const status =
    error !== null && typeof error === "object" && "status" in error
      ? error.status
      : null;
  if (status === 403) {
    return "You don't have permission to start Tasks on this project.";
  }
  if (status === 422) {
    return "This project has no usable repository, so there is nothing to ask about yet.";
  }
  return parseApiError(error, "Failed to start the Task");
}

export function RunsHeader({
  projectId,
  title,
  subtitle,
  initialComposing = false,
}: {
  projectId: string;
  title: string;
  subtitle?: string | undefined;
  /** Open the composer on mount (`?compose=1`); ignored for non-members. */
  initialComposing?: boolean;
}) {
  const isMember = useIsProjectMember();
  const [composing, setComposing] = useState(initialComposing);
  return (
    <>
      <Stack
        direction="row"
        alignItems="center"
        spacing={2}
        sx={{ mb: subtitle ? 2.5 : 2 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            component="h1"
            sx={{ fontSize: 22, fontWeight: 600 }}
            noWrap
          >
            {title}
          </Typography>
          {subtitle ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        {isMember ? (
          <Button
            variant="contained"
            size="small"
            disabled={composing}
            onClick={() => {
              setComposing(true);
            }}
          >
            ＋ New task
          </Button>
        ) : null}
      </Stack>
      {isMember && composing ? (
        <NewTask
          projectId={projectId}
          onCancel={() => {
            setComposing(false);
          }}
        />
      ) : null}
    </>
  );
}

function NewTask({
  projectId,
  onCancel,
}: {
  projectId: string;
  onCancel: () => void;
}) {
  const router = useRouter();
  const projectPath = useProjectPath();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = body.trim();

  const send = async () => {
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      const conversation = await createRepoConversation(projectId, trimmed);
      router.push(
        conversation.taskId
          ? projectPath("runs", "tasks", conversation.taskId)
          : projectPath("conversations", conversation.id),
      );
    } catch (sendError) {
      setError(newTaskError(sendError));
      setSending(false);
    }
  };

  return (
    <Box
      data-testid="runs-new-chat"
      sx={{
        mb: 2.5,
        p: 1.5,
        borderRadius: 2,
        border: 1,
        borderColor: (theme) => alpha(theme.palette.primary.main, 0.5),
        backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.06),
      }}
    >
      <Typography
        variant="caption"
        sx={{ color: "primary.main", fontWeight: 600 }}
      >
        ＋ New task about this project
      </Typography>
      <Stack direction="row" alignItems="flex-end" spacing={1}>
        <InputBase
          autoFocus
          multiline
          fullWidth
          placeholder="Ask anything about the repo…"
          value={body}
          disabled={sending}
          inputProps={{
            maxLength: CONVERSATION_MESSAGE_BODY_MAX_LENGTH,
            "aria-label": "Your question",
          }}
          onChange={(event) => {
            setBody(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          sx={{ fontSize: 15, mt: 0.5 }}
        />
        <Button size="small" color="inherit" onClick={onCancel}>
          Cancel
        </Button>
        <IconButton
          aria-label="Start task"
          disabled={!trimmed || sending}
          onClick={() => {
            void send();
          }}
          sx={{
            width: 34,
            height: 34,
            backgroundColor: "primary.main",
            color: "primary.contrastText",
            "&:hover": {
              backgroundColor: (theme) =>
                alpha(theme.palette.primary.main, 0.85),
            },
            "&.Mui-disabled": {
              backgroundColor: (theme) =>
                alpha(theme.palette.text.primary, 0.08),
            },
          }}
        >
          <ArrowUpwardIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Stack>
      {error ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      ) : null}
    </Box>
  );
}
