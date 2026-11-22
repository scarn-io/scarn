"use client";

/**
 * The Inbox page's rows: a waiting agent, a pipeline wait, a work item
 * waiting on the viewer, a stopped Task. A Task with no work item opens on
 * its own Task page.
 */

import type { ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import AssignmentIndOutlinedIcon from "@mui/icons-material/AssignmentIndOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import PanToolOutlinedIcon from "@mui/icons-material/PanToolOutlined";
import Link from "next/link";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  useHasProjectPermission,
  useProjectPath,
} from "@/components/project-route-context";
import { formatRelativeTime } from "@/components/executions/format-datetime";
import type { TaskSummary } from "@/components/tasks/task-api";
import { taskRunPath } from "@/components/runs/task-run-path";
import { TaskStatusChip } from "@/components/tasks/task-labels";
import { TaskKindIcon, taskDisplayName } from "@/components/tasks/task-display";
import { CONVERSATION_PARAM } from "@/components/work-items/use-conversation-param";
import { AGENTS_PANEL_ANCHOR } from "@/components/work-items/work-item-agents-panel";
import {
  QuestionBlock,
  ReplyBox,
  useRowAction,
} from "@/components/work-items/work-item-agents-panel-parts";
import {
  DecisionControls,
  postDecision,
} from "@/components/work-items/work-item-pipeline-wait-rows";
import { WorkItemLabelChips } from "@/components/work-items/work-items-table";
import type { InboxWait, InboxWorkItem } from "./inbox-api";

type WorkItemRef = NonNullable<TaskSummary["workItem"]>;

function InboxRowHeader({
  icon,
  name,
  workItem,
  href,
  status,
}: {
  icon: ReactNode;
  name: string;
  workItem: WorkItemRef | null;
  href: string;
  status?: ReactNode;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      useFlexGap
      flexWrap="wrap"
    >
      {icon}
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {name}
      </Typography>
      {status}
      <Typography
        variant="body2"
        color="text.secondary"
        noWrap
        sx={{ flex: 1, minWidth: 0 }}
      >
        {workItem?.title}
      </Typography>
      <Button
        size="small"
        component={Link}
        href={href}
        endIcon={<ArrowForwardIcon fontSize="small" />}
      >
        {`Open${workItem ? ` ${workItem.platformKey}` : ""}`}
      </Button>
    </Stack>
  );
}

/** Opens the Task's conversation sheet when it has one, else the agents panel. */
function useAgentsHref() {
  const projectPath = useProjectPath();
  return (workItem: WorkItemRef, conversationId: string | null = null) => {
    const workItemPath = projectPath("work-items", workItem.id);
    return conversationId
      ? `${workItemPath}?${CONVERSATION_PARAM}=${encodeURIComponent(conversationId)}`
      : `${workItemPath}#${AGENTS_PANEL_ANCHOR}`;
  };
}

/** An agent Task waiting on the viewer: its last message and a quick reply. */
export function InboxTaskRow({
  task,
  onChanged,
}: {
  task: TaskSummary;
  onChanged: () => void;
}) {
  const agentsHref = useAgentsHref();
  const projectPath = useProjectPath();
  const canReply = useHasProjectPermission("comments:create");
  const { pending, error, run } = useRowAction(onChanged);
  const name = taskDisplayName(task);
  const { conversationId } = task;

  return (
    <Stack spacing={1.25} sx={{ px: 2, py: 1.5 }} data-testid="inbox-task-row">
      <InboxRowHeader
        icon={<TaskKindIcon kind={task.kind} />}
        name={name}
        workItem={task.workItem}
        href={
          task.workItem
            ? agentsHref(task.workItem, conversationId)
            : taskRunPath(projectPath, task)
        }
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      {task.latest ? (
        <QuestionBlock
          body={task.latest.text}
          caption={`${name} · ${formatRelativeTime(task.updatedAt)}`}
          highlighted
        />
      ) : null}
      {conversationId && canReply ? (
        <ReplyBox
          placeholder={`Reply to ${name}…`}
          note={null}
          pending={pending !== null}
          canReply
          onReply={(body) =>
            run("reply", "Could not send the reply. Try again.", () =>
              unwrapTreatyResponse(
                getBrowserScarnApiClient()
                  .api.conversations({
                    conversationId: parseUuidV7(conversationId),
                  })
                  .messages.post({ body }),
              ),
            )
          }
        />
      ) : null}
    </Stack>
  );
}

/** A pipeline question (reply box) or decision (action buttons) on the viewer. */
export function InboxWaitRow({
  wait,
  onChanged,
}: {
  wait: InboxWait;
  onChanged: () => void;
}) {
  const agentsHref = useAgentsHref();
  const canReply = useHasProjectPermission("comments:create");
  const canDecide = useHasProjectPermission("executions:write");
  const { pending, error, run } = useRowAction(onChanged);
  const executionRoute = () =>
    getBrowserScarnApiClient().api["pipeline-executions"]({
      pipelineExecutionId: parseUuidV7(wait.pipelineExecutionId),
    });

  return (
    <Stack spacing={1.25} sx={{ px: 2, py: 1.5 }} data-testid="inbox-wait-row">
      <InboxRowHeader
        icon={
          wait.kind === "reply" ? (
            <ForumOutlinedIcon fontSize="small" color="warning" />
          ) : (
            <PanToolOutlinedIcon fontSize="small" color="warning" />
          )
        }
        name={
          wait.kind === "decision" && wait.title
            ? wait.title
            : `${wait.pipelineName} · ${wait.nodeId}`
        }
        workItem={wait.workItem}
        href={agentsHref(wait.workItem)}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      {wait.kind === "reply" ? (
        <>
          <QuestionBlock
            body={wait.body}
            caption={`Asked ${formatRelativeTime(wait.askedAt)}`}
            highlighted
          />
          {canReply ? (
            <ReplyBox
              placeholder="Answer the question…"
              note={null}
              pending={pending !== null}
              canReply
              onReply={(body) =>
                run("answer", "Could not send the answer. Try again.", () =>
                  unwrapTreatyResponse(
                    executionRoute()
                      .questions({ questionId: parseUuidV7(wait.questionId) })
                      .answer.post({ body }),
                  ),
                )
              }
            />
          ) : null}
        </>
      ) : (
        <>
          <Typography variant="body2" color="text.secondary">
            {wait.pipelineName} is paused at{" "}
            <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
              {wait.nodeId}
            </Box>{" "}
            until someone decides · {formatRelativeTime(wait.askedAt)}
          </Typography>
          {canDecide ? (
            <DecisionControls
              actions={wait.actions}
              pending={pending !== null}
              onDecide={(action, body) =>
                run(action, "Could not record the decision.", () =>
                  postDecision(
                    wait.pipelineExecutionId,
                    wait.visitId,
                    action,
                    body,
                  ),
                )
              }
            />
          ) : null}
        </>
      )}
    </Stack>
  );
}

/** A failed Task the viewer started, with its error; opens the item's Tasks tab, or the Task. */
export function InboxFailedTaskRow({ task }: { task: TaskSummary }) {
  const projectPath = useProjectPath();
  const href = task.workItem
    ? `${projectPath("work-items", task.workItem.id)}?tab=tasks`
    : taskRunPath(projectPath, task);
  return (
    <Stack
      spacing={0.75}
      sx={{ px: 2, py: 1.5 }}
      data-testid="inbox-failed-row"
    >
      <InboxRowHeader
        icon={<TaskKindIcon kind={task.kind} />}
        name={taskDisplayName(task)}
        workItem={task.workItem}
        href={href}
        status={<TaskStatusChip status={task.status} />}
      />
      <Typography
        variant="body2"
        color={task.latest?.kind === "error" ? "error" : "text.secondary"}
        sx={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
      >
        {task.latest?.text ?? "Failed without an error message."}
      </Typography>
      <MuiLink
        component={Link}
        href={taskRunPath(projectPath, task)}
        variant="caption"
        underline="hover"
        sx={{ alignSelf: "flex-start" }}
      >
        Open run · failed {formatRelativeTime(task.updatedAt)}
      </MuiLink>
    </Stack>
  );
}

/**
 * A ready work item nothing has started that waits on the viewer: its
 * title, labels, parent and how long it has waited; opens the item.
 */
export function InboxWorkItemRow({ workItem }: { workItem: InboxWorkItem }) {
  const projectPath = useProjectPath();
  return (
    <Stack
      spacing={0.5}
      sx={{ px: 2, py: 1.5 }}
      data-testid="inbox-work-item-row"
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <AssignmentIndOutlinedIcon fontSize="small" color="warning" />
        <Typography
          variant="body2"
          noWrap
          sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}
        >
          <MuiLink
            component={Link}
            href={projectPath("work-items", workItem.id)}
            underline="hover"
            color="inherit"
          >
            {workItem.title}
          </MuiLink>
          <WorkItemLabelChips labels={workItem.labels} />
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ pl: 3.5 }}>
        {workItem.parent ? (
          <>
            In{" "}
            <MuiLink
              component={Link}
              href={projectPath("work-items", workItem.parent.id)}
              underline="hover"
              color="inherit"
            >
              {workItem.parent.title}
            </MuiLink>{" "}
            ·{" "}
          </>
        ) : null}
        Nothing started · ready {formatRelativeTime(workItem.waitingSince)}
      </Typography>
    </Stack>
  );
}
