"use client";

import NextLink from "next/link";
import { Chip, Link, Stack, Typography } from "@mui/material";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import { RecordList } from "@/components/common/record-list/record-list";
import { RecordListRow } from "@/components/common/record-list/record-list-row";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import { useProjectPath } from "@/components/project-route-context";
import { formatDateTime } from "@/components/executions/format-datetime";

const SCOPE_LABELS: Record<AutomationContract["scope"], string> = {
  project: "Project",
  workItem: "Work item",
};

/**
 * Settings page "Automations" section: every automation pushed to this
 * project, with its scope, latest version and whether a project automation
 * is on. Switching one on or off happens on the Pipelines & Automations
 * page, which this links to; work-item automations are attached from a
 * work item's page.
 */
export function ProjectAutomationsPanel({
  automations,
}: {
  automations: AutomationContract[];
}) {
  const buildPath = useProjectPath();

  return (
    <Stack spacing={1.5}>
      <RecordList title="Automations" count={automations.length}>
        {automations.length === 0 ? (
          <RecordListEmpty
            title="No automations"
            description="Push an automation with `scarn pipelines push` to see it here."
          />
        ) : (
          automations.map((automation, index) => (
            <RecordListRow
              key={automation.id}
              isFirst={index === 0}
              primary={
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {automation.title ?? automation.key}
                </Typography>
              }
              secondary={
                <Typography variant="caption" color="text.secondary">
                  {automation.latestVersion
                    ? `${automation.key} · v${String(automation.latestVersion.version)} · published ${formatDateTime(automation.latestVersion.publishedAt)}`
                    : `${automation.key} · not published`}
                </Typography>
              }
              trailing={
                <>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={SCOPE_LABELS[automation.scope]}
                  />
                  {automation.scope === "project" ? (
                    <Typography variant="body2" color="text.secondary">
                      {automation.enabled ? "Enabled" : "Disabled"}
                    </Typography>
                  ) : null}
                </>
              }
            />
          ))
        )}
      </RecordList>
      <Link
        component={NextLink}
        href={buildPath("pipelines")}
        variant="body2"
        underline="hover"
      >
        Manage automations in Pipelines &amp; Automations →
      </Link>
    </Stack>
  );
}
