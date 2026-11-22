"use client";

/**
 * The Task view: a breadcrumb back to Tasks, a header (name, status, then
 * kind · work item · pipeline run · duration · who started it) over the
 * Task's runs, shown with the run view's transcript and logs panels. A code
 * Task has no transcript, so it opens on its logs. Polls while the Task is
 * still live. Inside a run's page (`framed`), the run header stands in for
 * the breadcrumb and header.
 */

import {
  Box,
  Chip,
  CircularProgress,
  Link as MuiLink,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { TaskRunContract } from "@scarn/api/frontend-contracts";
import { assertNever } from "@scarn/core/lib/assert-never";
import { useProjectPath } from "@/components/project-route-context";
import { StepThread } from "@/components/executions/step-thread";
import { StepLogsView } from "@/components/executions/step-logs-view";
import type { LogStreamFilter } from "@/components/executions/log-viewer";
import { formatDateTime } from "@/components/executions/format-datetime";
import { formatElapsedMs } from "@/components/executions/elapsed";
import { useWorkItemExecutions } from "@/components/executions/use-work-item-executions";
import { type TaskDetail } from "./task-api";
import { useTask } from "./use-task";
import { TaskRetryAction } from "./task-retry-action";
import { TaskStatusChip, startedByLabel } from "./task-labels";
import { taskThreadRuns } from "./task-runs";
import {
  TaskKindIcon,
  pipelineRunLabel,
  taskDisplayName,
  taskKindLabel,
} from "./task-display";

export { useTask } from "./use-task";

type View = "transcript" | "logs";

export function TaskView({
  taskId,
  projectId,
  framed = false,
}: {
  taskId: string;
  projectId: string;
  /** Leaves out the breadcrumb and header, for a run page's frame. */
  framed?: boolean;
}) {
  const state = useTask(taskId, projectId);

  if (state.status === "not-found") notFound();
  if (state.status === "loading") {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 4 }}>
        <CircularProgress size={24} />
        <Typography color="text.secondary">Loading task…</Typography>
      </Box>
    );
  }
  if (state.status === "error") {
    return (
      <Typography color="error" sx={{ mt: 4 }}>
        {state.message}
      </Typography>
    );
  }
  return (
    <TaskViewBody
      projectId={projectId}
      task={state.task}
      runs={state.runs}
      onRefresh={state.reload}
      framed={framed}
    />
  );
}

/**
 * From the first run's start to the last run's end, or to now while a run
 * is still going; `null` before any run has started.
 */
export function taskRunsDuration(
  runs: readonly Pick<TaskRunContract, "startedAt" | "completedAt">[],
  now: number = Date.now(),
): string | null {
  const startedAt = runs[0]?.startedAt;
  if (!startedAt) return null;
  const completedAt = runs.at(-1)?.completedAt;
  const end = completedAt ? new Date(completedAt).getTime() : now;
  return formatElapsedMs(end - new Date(startedAt).getTime());
}

function taskKindHasTranscript(kind: TaskDetail["kind"]): boolean {
  switch (kind) {
    case "agent":
      return true;
    case "code":
    case "mcp_tool":
      return false;
    default:
      return assertNever(kind);
  }
}

function TaskViewBody({
  projectId,
  task,
  runs,
  onRefresh,
  framed,
}: {
  projectId: string;
  task: TaskDetail;
  runs: TaskRunContract[];
  onRefresh: () => void;
  framed: boolean;
}) {
  const threadRuns = useMemo(() => taskThreadRuns(runs), [runs]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasTranscript = taskKindHasTranscript(task.kind);
  const [view, setView] = useState<View>(hasTranscript ? "transcript" : "logs");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [logsRunNumber, setLogsRunNumber] = useState<number | null>(null);
  const [filter, setFilter] = useState<LogStreamFilter>("all");
  const [fullScreen, setFullScreen] = useState(false);

  const openLogs = (runNumber: number) => {
    setLogsRunNumber(runNumber);
    setView("logs");
  };

  return (
    <Stack spacing={2}>
      {fullScreen ? null : (
        <>
          {framed ? null : (
            <TaskHeader projectId={projectId} task={task} runs={runs} />
          )}
          <TaskRetryAction
            task={task}
            runs={runs}
            onRefresh={onRefresh}
            onRetried={() => {
              setLogsRunNumber(null);
            }}
          />
          <Tabs
            value={view}
            onChange={(_event, next: View) => {
              setView(next);
            }}
          >
            {hasTranscript ? (
              <Tab value="transcript" label="Transcript" />
            ) : null}
            <Tab value="logs" label="Logs" />
          </Tabs>
        </>
      )}

      {view === "transcript" ? (
        threadRuns.length === 0 ? (
          <Typography color="text.secondary">
            This task hasn&apos;t run yet.
          </Typography>
        ) : (
          <Box ref={scrollRef}>
            <StepThread
              runs={threadRuns}
              expanded={expanded}
              onToggleRun={(runId, open) => {
                setExpanded((prev) => ({ ...prev, [runId]: open }));
              }}
              scrollRef={scrollRef}
              onOpenOutput={(run) => {
                openLogs(run.runNumber);
              }}
              onOpenLogs={(run) => {
                openLogs(run.runNumber);
              }}
            />
          </Box>
        )
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", minHeight: 400 }}>
          <StepLogsView
            runs={threadRuns}
            loading={false}
            runNumber={logsRunNumber}
            onRunChange={setLogsRunNumber}
            filter={filter}
            onFilterChange={setFilter}
            fullScreen={fullScreen}
            onFullScreenChange={setFullScreen}
          />
        </Box>
      )}
    </Stack>
  );
}

function TaskHeader({
  projectId,
  task,
  runs,
}: {
  projectId: string;
  task: TaskDetail;
  runs: readonly TaskRunContract[];
}) {
  const projectPath = useProjectPath();
  const executions = useWorkItemExecutions(
    projectId,
    task.workItem?.id ?? null,
  );
  const runLabel = pipelineRunLabel(task, executions);
  const duration = taskRunsDuration(runs);
  const name = taskDisplayName(task);
  const dot = (
    <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
      ·
    </Box>
  );

  return (
    <Stack spacing={1.5} sx={{ mb: 1 }}>
      <Typography
        component="nav"
        aria-label="Breadcrumb"
        variant="body2"
        color="text.secondary"
        sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}
      >
        <MuiLink
          component={Link}
          href={projectPath("runs")}
          underline="hover"
          color="inherit"
        >
          Runs
        </MuiLink>
        <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
          ›
        </Box>
        <Box
          component="span"
          aria-current="page"
          sx={{
            color: "text.primary",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </Box>
      </Typography>

      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        justifyContent="space-between"
      >
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ minWidth: 0 }}
        >
          <TaskKindIcon kind={task.kind} />
          <Typography
            variant="h1"
            sx={{ fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.4 }}
          >
            {name}
          </Typography>
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ flexShrink: 0 }}
        >
          {task.waitingOnYou ? (
            <Chip size="small" color="warning" label="Waiting on you" />
          ) : null}
          <TaskStatusChip status={task.status} />
        </Stack>
      </Stack>

      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        flexWrap="wrap"
        alignItems="center"
        data-testid="task-caption"
      >
        <Typography variant="body2" color="text.secondary">
          {taskKindLabel(task.kind)}
        </Typography>
        {task.workItem ? (
          <>
            {dot}
            <Typography variant="body2" color="text.secondary">
              <MuiLink
                component={Link}
                href={projectPath("work-items", task.workItem.id)}
                underline="hover"
              >
                {task.workItem.platformKey} {task.workItem.title}
              </MuiLink>
            </Typography>
          </>
        ) : null}
        {task.pipelineRunId ? (
          <>
            {dot}
            <MuiLink
              component={Link}
              href={projectPath("runs", task.pipelineRunId)}
              variant="body2"
              underline="hover"
            >
              {runLabel ?? "Pipeline run"}
            </MuiLink>
            {task.nodeId ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ fontFamily: "var(--font-mono)" }}
              >
                {task.nodeId}
              </Typography>
            ) : null}
          </>
        ) : null}
        {duration ? (
          <>
            {dot}
            <Typography variant="body2" color="text.secondary">
              {duration}
            </Typography>
          </>
        ) : null}
        {dot}
        <Typography variant="body2" color="text.secondary">
          Started by {startedByLabel(task)} · {formatDateTime(task.createdAt)}
        </Typography>
      </Stack>
    </Stack>
  );
}
