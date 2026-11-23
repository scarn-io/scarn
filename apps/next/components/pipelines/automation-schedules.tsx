"use client";

/**
 * A project automation's schedule rules, one compact block each: the rule
 * key, cron and timezone, the next run, and how its runs went (last fired,
 * last Task's status, failure streak, last skip, last error), with a link to
 * the rule's history in Runs and a Run now button.
 */

import { useState } from "react";
import NextLink from "next/link";
import type {
  AutomationScheduleSummaryContract,
  RunAutomationScheduleResult,
} from "@scarn/api/frontend-contracts";
import { Box, Button, Link, Stack, Typography } from "@mui/material";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import {
  apiErrorCode,
  apiErrorMeta,
  parseApiError,
} from "@/app/_lib/api-error";
import {
  formatDateTime,
  formatRelativeTime,
} from "@/components/executions/format-datetime";
import { useProjectPath } from "@/components/project-route-context";
import {
  ScheduleIcon,
  useScheduleHistoryHref,
} from "@/components/runs/run-row-parts";
import { TaskStatusChip } from "@/components/tasks/task-labels";

const UTC = "UTC";

/** `0 * * * *`, or `0 9 * * 1-5 Europe/Paris` when not UTC. */
export const scheduleWhen = (
  schedule: Pick<AutomationScheduleSummaryContract, "cron" | "timezone">,
): string =>
  schedule.timezone === UTC
    ? schedule.cron
    : `${schedule.cron} ${schedule.timezone}`;

type RunNowOutcome =
  | { kind: "started"; taskId: string }
  | { kind: "skipped" }
  | { kind: "busy"; heldBy: string[] }
  | { kind: "error"; message: string };

const heldByOf = (meta: Record<string, unknown> | undefined): string[] => {
  const heldBy = meta?.["heldBy"];
  return Array.isArray(heldBy)
    ? heldBy.filter((id): id is string => typeof id === "string")
    : [];
};

async function runScheduleNow(
  projectId: string,
  key: string,
  ruleKey: string,
): Promise<RunNowOutcome> {
  const { data, error } = await getBrowserScarnApiClient()
    .api.projects({ projectId })
    .automations({ key })
    .schedules({ ruleKey })
    .runs.post();
  if (error) {
    if (apiErrorCode(error) === "Scarn.ConcurrencyGroupFull") {
      return { kind: "busy", heldBy: heldByOf(apiErrorMeta(error)) };
    }
    return {
      kind: "error",
      message: parseApiError(error, "Could not run the schedule. Try again."),
    };
  }
  const result: RunAutomationScheduleResult = data;
  return result.taskId === null
    ? { kind: "skipped" }
    : { kind: "started", taskId: result.taskId };
}

function Fact({
  children,
  title,
  tone,
  testId,
}: {
  children: React.ReactNode;
  title?: string;
  tone?: "warning" | "error";
  testId?: string;
}) {
  return (
    <Box
      component="span"
      title={title}
      data-testid={testId}
      sx={{
        color: tone ? `${tone}.main` : "text.secondary",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </Box>
  );
}

function TaskLinks({ ids }: { ids: readonly string[] }) {
  const buildPath = useProjectPath();
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 ? ", " : null}
          <Link
            component={NextLink}
            href={buildPath("runs", "tasks", id)}
            underline="hover"
            sx={{ fontFamily: "var(--font-mono)" }}
          >
            {id.slice(-8)}
          </Link>
        </span>
      ))}
    </>
  );
}

function RunNowFeedback({ outcome }: { outcome: RunNowOutcome }) {
  const buildPath = useProjectPath();
  switch (outcome.kind) {
    case "started":
      return (
        <Typography variant="caption" color="success.main" component="div">
          Started.{" "}
          <Link
            component={NextLink}
            href={buildPath("runs", "tasks", outcome.taskId)}
            underline="hover"
          >
            Open the Task →
          </Link>
        </Typography>
      );
    case "skipped":
      return (
        <Typography variant="caption" color="text.secondary" component="div">
          The rule routed to skip; no Task started.
        </Typography>
      );
    case "busy":
      return (
        <Typography variant="caption" color="warning.main" component="div">
          Busy: the schedule&apos;s concurrency group is full
          {outcome.heldBy.length > 0 ? (
            <>
              , held by Task{outcome.heldBy.length === 1 ? "" : "s"}{" "}
              <TaskLinks ids={outcome.heldBy} />
            </>
          ) : null}
          . Try again when it finishes.
        </Typography>
      );
    case "error":
      return (
        <Typography variant="caption" color="error.main" component="div">
          {outcome.message}
        </Typography>
      );
  }
}

function ScheduleSummary({
  projectId,
  automationKey,
  schedule,
  canRun,
  onRan,
}: {
  projectId: string;
  automationKey: string;
  schedule: AutomationScheduleSummaryContract;
  canRun: boolean;
  onRan: () => void;
}) {
  const historyHref = useScheduleHistoryHref();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<RunNowOutcome | null>(null);

  const runNow = async () => {
    setPending(true);
    setOutcome(null);
    try {
      const next = await runScheduleNow(projectId, automationKey, schedule.key);
      setOutcome(next);
      if (next.kind === "started" || next.kind === "skipped") onRan();
    } finally {
      setPending(false);
    }
  };

  return (
    <Box data-testid="automation-schedule" data-schedule-key={schedule.key}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        useFlexGap
        flexWrap="wrap"
        sx={{ fontSize: 12.5 }}
      >
        <Box component="span" sx={{ fontWeight: 600 }}>
          <ScheduleIcon title="Schedule rule" />
          {schedule.key}
        </Box>
        <Box
          component="code"
          sx={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        >
          {scheduleWhen(schedule)}
        </Box>
        <Fact
          title={
            schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : undefined
          }
        >
          {schedule.nextRunAt
            ? `next ${formatRelativeTime(schedule.nextRunAt)}`
            : "off while disabled"}
        </Fact>
        <Box sx={{ flex: 1 }} />
        <Link
          component={NextLink}
          href={historyHref(schedule.id)}
          variant="caption"
          underline="hover"
        >
          History
        </Link>
        {canRun ? (
          <Button
            size="small"
            variant="outlined"
            disabled={pending}
            onClick={() => {
              void runNow();
            }}
            sx={{ py: 0, minWidth: 0, fontSize: 12 }}
          >
            {pending ? "Running…" : "Run now"}
          </Button>
        ) : null}
      </Stack>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        useFlexGap
        flexWrap="wrap"
        sx={{ fontSize: 12, mt: 0.25 }}
      >
        <Fact
          title={
            schedule.lastFiredAt
              ? formatDateTime(schedule.lastFiredAt)
              : undefined
          }
        >
          {schedule.lastFiredAt
            ? `fired ${formatRelativeTime(schedule.lastFiredAt)}`
            : "never fired"}
        </Fact>
        {schedule.lastTask ? (
          <Box
            component="span"
            data-testid="schedule-last-task"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
          >
            <Fact>last Task</Fact>
            <TaskStatusChip status={schedule.lastTask.status} />
          </Box>
        ) : null}
        {schedule.failureStreak > 0 ? (
          <Fact tone="warning" testId="schedule-failure-streak">
            {schedule.failureStreak === 1
              ? "1 failure"
              : `${String(schedule.failureStreak)} failures in a row`}
          </Fact>
        ) : null}
        {schedule.lastSkippedAt ? (
          <Fact title={formatDateTime(schedule.lastSkippedAt)}>
            skipped {formatRelativeTime(schedule.lastSkippedAt)}
            {schedule.skippedCountSinceFire > 1
              ? ` (${String(schedule.skippedCountSinceFire)}× since it fired)`
              : ""}
          </Fact>
        ) : null}
        {schedule.lastError ? (
          <Fact
            tone="error"
            testId="schedule-last-error"
            title={`${schedule.lastError.message} (${formatDateTime(schedule.lastError.at)})`}
          >
            <Box
              component="span"
              sx={{
                display: "inline-block",
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                verticalAlign: "bottom",
              }}
            >
              error: {schedule.lastError.message}
            </Box>
          </Fact>
        ) : null}
      </Stack>
      {outcome ? <RunNowFeedback outcome={outcome} /> : null}
    </Box>
  );
}

export function AutomationSchedules({
  projectId,
  automationKey,
  schedules,
  canRun,
  onRan,
}: {
  projectId: string;
  automationKey: string;
  schedules: readonly AutomationScheduleSummaryContract[];
  /** Shows Run now; the viewer needs `executions:write`. */
  canRun: boolean;
  /** After a Run now fired, so the summaries can be read again. */
  onRan: () => void;
}) {
  if (schedules.length === 0) return null;
  return (
    <Stack spacing={0.75} sx={{ mt: 0.75 }} aria-label="Schedules">
      {schedules.map((schedule) => (
        <ScheduleSummary
          key={schedule.id}
          projectId={projectId}
          automationKey={automationKey}
          schedule={schedule}
          canRun={canRun}
          onRan={onRan}
        />
      ))}
    </Stack>
  );
}
