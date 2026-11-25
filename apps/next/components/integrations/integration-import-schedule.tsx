"use client";

import NextLink from "next/link";
import { Box, Link, Stack, Typography } from "@mui/material";
import {
  formatDateTime,
  formatRelativeTime,
} from "@/components/executions/format-datetime";
import { useProjectPath } from "@/components/project-route-context";
import { TaskStatusChip } from "@/components/tasks/task-labels";
import type { ImportedIntegration, ImportSchedule } from "./import-schedules";

const LIBRARY: Record<
  ImportedIntegration["kind"],
  { module: string; factory: string }
> = {
  jira: { module: "@scarn/sdk/library/jira", factory: "jiraIssueImport" },
  github_token: {
    module: "@scarn/sdk/library/github",
    factory: "githubIssueImport",
  },
};

function ScheduleLine({ automation, schedule }: ImportSchedule) {
  const lastRunAt = schedule.lastTask?.scheduledFor ?? schedule.lastFiredAt;
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
      data-testid="integration-import-schedule"
    >
      <Typography variant="caption" color="text.secondary">
        {`Imported by ${automation.title ?? automation.key} · `}
        {automation.enabled ? (
          lastRunAt ? (
            <span title={formatDateTime(lastRunAt)}>
              {`last run ${formatRelativeTime(lastRunAt)}`}
            </span>
          ) : (
            "not run yet"
          )
        ) : (
          "off while disabled"
        )}
      </Typography>
      {schedule.lastTask ? (
        <TaskStatusChip status={schedule.lastTask.status} />
      ) : null}
      {schedule.failureStreak > 1 ? (
        <Typography variant="caption" color="warning.main">
          {`${String(schedule.failureStreak)} failures in a row`}
        </Typography>
      ) : null}
    </Stack>
  );
}

/**
 * A token integration's import schedule: the last run of each schedule rule
 * that imports its issues, or how to add one with the SDK's library poller.
 */
export function IntegrationImportSchedule({
  integration,
  schedules,
}: {
  integration: ImportedIntegration;
  schedules: readonly ImportSchedule[];
}) {
  const buildPath = useProjectPath();
  const { module, factory } = LIBRARY[integration.kind];
  return (
    <Stack spacing={0.5} sx={{ pt: 0.5 }}>
      {schedules.length > 0 ? (
        schedules.map((entry) => (
          <ScheduleLine
            key={entry.schedule.id}
            automation={entry.automation}
            schedule={entry.schedule}
          />
        ))
      ) : (
        <Typography variant="caption" color="text.secondary">
          Syncs only when you ask. To import on a schedule, export a{" "}
          <Box component="code">{`${factory}(…)`}</Box> step from{" "}
          <Box component="code">{module}</Box> in a <code>.scarn</code> file,
          then add{" "}
          <Box component="code">{`${factory}.schedule(step, { cron })`}</Box> to
          an automation&apos;s rules.
        </Typography>
      )}
      <Link
        component={NextLink}
        href={buildPath("pipelines")}
        variant="caption"
        underline="hover"
      >
        Pipelines &amp; Automations →
      </Link>
    </Stack>
  );
}
