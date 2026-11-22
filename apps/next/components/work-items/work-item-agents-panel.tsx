"use client";

import { useEffect, type ReactNode } from "react";
import { Alert, Box, Button, Chip, Stack, Typography } from "@mui/material";
import StopIcon from "@mui/icons-material/Stop";
import {
  parseUuidV7,
  type WorkItemConversationContract,
  type WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  useHasProjectPermission,
  useIsProjectMember,
  useProjectPath,
} from "@/components/project-route-context";
import type { TaskSummary } from "@/components/tasks/task-api";
import { taskRunPath } from "@/components/runs/task-run-path";
import { TaskStatusChip } from "@/components/tasks/task-labels";
import { TaskKindIcon, taskDisplayName } from "@/components/tasks/task-display";
import type { DecisionWait } from "./use-work-item-decision-waits";
import { RowHeader, useRowAction } from "./work-item-agents-panel-parts";
import { ConversationSummaryRow } from "./work-item-conversation-row";
import {
  DecisionRow,
  PipelineQuestionRow,
} from "./work-item-pipeline-wait-rows";

/** The panel's element id, so links can land on it (`#agents`). */
export const AGENTS_PANEL_ANCHOR = "agents";

/**
 * "Agents on this": one row per live Task on the work item (agent or
 * code) and per open pipeline question or decision. A Task with a
 * conversation is a summary row that opens the conversation sheet; the
 * conversation itself is read and answered there. Renders nothing when
 * nothing is live.
 */
export function WorkItemAgentsPanel({
  tasks,
  conversations,
  questions,
  decisionWaits,
  viewerUsername,
  onOpenConversation,
  onChanged,
}: {
  /** The item's running, queued and waiting-for-person Tasks. */
  tasks: readonly TaskSummary[];
  conversations: readonly WorkItemConversationContract[];
  /** The item's open pipeline questions. */
  questions: readonly WorkItemQuestionContract[];
  decisionWaits: readonly DecisionWait[];
  /** Marks the viewer's own messages in the previews. */
  viewerUsername: string | null;
  /** Opens a conversation in the sheet. */
  onOpenConversation: (conversationId: string) => void;
  /** Re-reads the Tasks, conversations, questions and runs after an action. */
  onChanged: () => void;
}) {
  const count = tasks.length + questions.length + decisionWaits.length;
  const visible = count > 0;
  useEffect(() => {
    if (!visible || window.location.hash !== `#${AGENTS_PANEL_ANCHOR}`) return;
    document.getElementById(AGENTS_PANEL_ANCHOR)?.scrollIntoView();
  }, [visible]);
  if (!visible) return null;
  const waitingOnYou =
    tasks.filter((task) => task.waitingOnYou).length +
    questions.filter((question) => question.waitingOnYou).length;
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const rows: { key: string; node: ReactNode }[] = [
    ...tasks.map((task) => ({
      key: task.id,
      node: (
        <LiveTaskRow
          task={task}
          conversation={
            task.conversationId
              ? (conversationsById.get(task.conversationId) ?? null)
              : null
          }
          viewerUsername={viewerUsername}
          onOpenConversation={onOpenConversation}
          onChanged={onChanged}
        />
      ),
    })),
    ...questions.map((question) => ({
      key: question.questionId,
      node: <PipelineQuestionRow question={question} onChanged={onChanged} />,
    })),
    ...decisionWaits.map((wait) => ({
      key: wait.visit.id,
      node: <DecisionRow wait={wait} onChanged={onChanged} />,
    })),
  ];

  return (
    <Box
      component="section"
      id={AGENTS_PANEL_ANCHOR}
      aria-label="Agents on this"
      data-waiting-on-you={waitingOnYou > 0 ? "true" : undefined}
      sx={{
        border: 1,
        borderColor: waitingOnYou > 0 ? "warning.main" : "divider",
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: "background.paper",
        scrollMarginTop: 16,
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: "divider" }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: waitingOnYou > 0 ? "warning.main" : "info.main",
          }}
        />
        <Typography
          component="h2"
          variant="body2"
          sx={{ fontWeight: 600, flex: 1 }}
        >
          Agents on this ({count})
        </Typography>
        {waitingOnYou > 0 ? (
          <Chip
            size="small"
            color="warning"
            label={`${String(waitingOnYou)} waiting on you`}
          />
        ) : null}
      </Stack>
      {rows.map((row, index) => (
        <Box
          key={row.key}
          sx={{ borderTop: index ? 1 : 0, borderColor: "divider" }}
        >
          {row.node}
        </Box>
      ))}
    </Box>
  );
}

function LiveTaskRow({
  task,
  conversation,
  viewerUsername,
  onOpenConversation,
  onChanged,
}: {
  task: TaskSummary;
  conversation: WorkItemConversationContract | null;
  viewerUsername: string | null;
  onOpenConversation: (conversationId: string) => void;
  onChanged: () => void;
}) {
  const { conversationId } = task;
  if (conversationId) {
    return (
      <ConversationSummaryRow
        task={task}
        conversation={conversation}
        viewerUsername={viewerUsername}
        onOpen={() => {
          onOpenConversation(conversationId);
        }}
      />
    );
  }
  return <TaskProgressRow task={task} onChanged={onChanged} />;
}

/** A Task without a conversation: its latest output, Stop and Open run. */
function TaskProgressRow({
  task,
  onChanged,
}: {
  task: TaskSummary;
  onChanged: () => void;
}) {
  const projectPath = useProjectPath();
  const isMember = useIsProjectMember();
  const canAct = useHasProjectPermission("executions:write") && isMember;
  const { pending, error, run } = useRowAction(onChanged);
  const waiting = task.status === "waiting_for_person";

  const stop =
    canAct && task.kind !== "code" ? (
      <Button
        size="small"
        color="error"
        startIcon={<StopIcon fontSize="small" />}
        disabled={pending !== null}
        onClick={() => {
          void run("stop", "Could not stop the task. Try again.", () =>
            unwrapTreatyResponse(
              getBrowserScarnApiClient()
                .api.tasks({ taskId: parseUuidV7(task.id) })
                .cancel.post(),
            ),
          );
        }}
      >
        Stop
      </Button>
    ) : null;

  return (
    <Stack spacing={1.25} sx={{ px: 2, py: 1.5 }} data-testid="agent-row">
      <RowHeader
        icon={<TaskKindIcon kind={task.kind} />}
        name={taskDisplayName(task)}
        href={taskRunPath(projectPath, task)}
        status={<TaskStatusChip status={task.status} />}
        waitingOnYou={task.waitingOnYou}
        waitingOn={waiting ? task.waitingOn : []}
        actions={stop}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}

      {waiting ? (
        <Typography variant="body2" color="text.secondary">
          Waiting for a person.
        </Typography>
      ) : task.status === "queued" ? (
        <Typography variant="body2" color="text.secondary">
          Queued — waiting for a worker.
        </Typography>
      ) : (
        <Typography
          variant="body2"
          data-testid="last-log-line"
          sx={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "text.secondary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task.latest?.text ?? "Waiting for run output…"}
        </Typography>
      )}
    </Stack>
  );
}
