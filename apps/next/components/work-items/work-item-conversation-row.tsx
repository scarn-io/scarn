"use client";

import { Box, ButtonBase, Chip, Stack, Typography } from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { WorkItemConversationContract } from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "@/components/tasks/task-api";
import { TaskKindIcon, taskDisplayName } from "@/components/tasks/task-display";
import { waitingOnLabel } from "./work-item-agents-panel-parts";

const plainText = (body: string) =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The last thing said, with "You: " in front when the viewer said it. */
function conversationPreview(
  conversation: WorkItemConversationContract | null,
  viewerUsername: string | null,
): string {
  const messages = conversation?.messages ?? [];
  const last = [...messages]
    .reverse()
    .find((message) => message.authorKind !== "system");
  if (!last) return "";
  const mine =
    last.authorKind === "person" &&
    viewerUsername !== null &&
    last.authorName === viewerUsername;
  return `${mine ? "You: " : ""}${plainText(last.body)}`;
}

/**
 * A Task with a conversation, on the work item's agents panel: who, whether
 * it waits on someone, a two-line preview of the last message, and one way
 * in. The whole row opens the conversation sheet.
 */
export function ConversationSummaryRow({
  task,
  conversation,
  viewerUsername,
  onOpen,
}: {
  task: TaskSummary;
  conversation: WorkItemConversationContract | null;
  viewerUsername: string | null;
  onOpen: () => void;
}) {
  const name = taskDisplayName(task);
  const waiting = task.status === "waiting_for_person";
  const thinking =
    !waiting &&
    (conversation?.status === "agent_turn" ||
      conversation?.status === "reply_pending");
  const preview = thinking
    ? "Thinking…"
    : conversationPreview(conversation, viewerUsername);
  const waitingOnYou = waiting && task.waitingOnYou;

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <ButtonBase
        onClick={onOpen}
        aria-label={`Open conversation with ${name}`}
        data-testid="conversation-summary-row"
        sx={{
          width: "100%",
          minHeight: 72,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 1.5,
          py: 1.25,
          textAlign: "left",
          borderRadius: 1,
          border: 1,
          borderColor: waitingOnYou ? "warning.main" : "divider",
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <TaskKindIcon kind={task.kind} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            useFlexGap
            flexWrap="wrap"
            sx={{ mb: 0.25 }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {name}
            </Typography>
            {waitingOnYou ? (
              <Chip size="small" color="warning" label="You" />
            ) : waiting && task.waitingOn.length > 0 ? (
              <Chip
                size="small"
                variant="outlined"
                label={`Waiting on ${waitingOnLabel(task.waitingOn)}`}
              />
            ) : null}
          </Stack>
          {preview ? (
            <Typography
              variant="body2"
              color="text.secondary"
              data-testid="conversation-preview"
              sx={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {preview}
            </Typography>
          ) : null}
        </Box>
        <Stack
          direction="row"
          alignItems="center"
          aria-hidden
          sx={{
            flexShrink: 0,
            typography: "body2",
            fontWeight: 600,
            color: waitingOnYou ? "warning.main" : "text.secondary",
          }}
        >
          {waitingOnYou ? "Reply" : "Open"}
          <ChevronRightIcon fontSize="small" />
        </Stack>
      </ButtonBase>
    </Box>
  );
}
