"use client";

import { useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Divider,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import BoltIcon from "@mui/icons-material/Bolt";
import Link from "next/link";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { formatDateTime } from "@/components/executions/format-datetime";
import {
  ExecutionStatusIcon,
  getExecutionStatusLabel,
} from "@/components/executions/execution-status-icon";
import type { WorkItemExecutionsData } from "@/components/executions/use-work-item-executions";
import type { TaskSummary } from "@/components/tasks/task-api";
import { taskRunPath } from "@/components/runs/task-run-path";
import { StartTaskButton } from "@/components/tasks/start-task-dialog";
import { taskDisplayName } from "@/components/tasks/task-display";
import { PlatformIcon, platformLabel } from "./work-item-platform";
import { WorkItemAssignee } from "./work-item-assignee";
import { WorkItemAutomations } from "./work-item-automations";
import { WorkItemLabels } from "./work-item-labels";
import { WorkItemSidebarRelationships } from "./work-item-sidebar-relationships";
import {
  WorkItemStatusLabel,
  type WorkItemRingStatus,
} from "./work-item-status-ring";

function PropertyRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "110px minmax(0, 1fr)",
        columnGap: 1.5,
        alignItems: "baseline",
      }}
    >
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

const Muted = ({ children }: { children: ReactNode }) => (
  <Typography variant="body2" color="text.secondary">
    {children}
  </Typography>
);

/**
 * The work item page's Properties panel: status, people, labels,
 * automations and agents, type,
 * relationships, what's feeding the agent and the pipeline runs; then the
 * timestamps, the source link, Start task and the raw fields.
 */
export function WorkItemProperties({
  projectId,
  workItem,
  ringStatus,
  tasks,
  pinnedCount,
  executionsData,
  onOpenExecutions,
  onWorkItemChanged,
}: {
  projectId: string;
  workItem: WorkItemContract;
  ringStatus: WorkItemRingStatus;
  tasks: readonly TaskSummary[];
  pinnedCount: number | undefined;
  executionsData: Pick<
    WorkItemExecutionsData,
    "executions" | "definitionsById" | "total" | "loading"
  >;
  onOpenExecutions: () => void;
  onWorkItemChanged: (updated: WorkItemContract) => void;
}) {
  const projectPath = useProjectPath();
  const agentTasks = tasks.filter((task) => task.kind === "agent");
  const latestRun = executionsData.executions[0];
  const latestPipelineName = latestRun
    ? (executionsData.definitionsById.get(latestRun.pipelineDefinitionId)
        ?.name ?? "Pipeline")
    : null;

  return (
    <Stack spacing={2} component="aside" aria-label="Properties">
      <Typography
        component="h2"
        variant="body2"
        sx={{ fontWeight: 600, color: "text.secondary" }}
      >
        Properties
      </Typography>

      <Stack spacing={1.5}>
        <PropertyRow label="Status">
          <WorkItemStatusLabel status={ringStatus} />
        </PropertyRow>
        <PropertyRow label="Assignee">
          <WorkItemAssignee
            projectId={projectId}
            workItem={workItem}
            onWorkItemChanged={onWorkItemChanged}
          />
        </PropertyRow>
        <PropertyRow label="Labels">
          <WorkItemLabels
            projectId={projectId}
            workItem={workItem}
            onWorkItemChanged={onWorkItemChanged}
          />
        </PropertyRow>
        <PropertyRow label="Automations">
          <WorkItemAutomations projectId={projectId} workItem={workItem} />
        </PropertyRow>
        <PropertyRow label="Agents">
          {agentTasks.length === 0 ? (
            <Muted>None yet</Muted>
          ) : (
            <Stack spacing={0.25}>
              {agentTasks.map((task) => (
                <MuiLink
                  key={task.id}
                  component={Link}
                  href={taskRunPath(projectPath, task)}
                  variant="body2"
                  underline="hover"
                  color="inherit"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {taskDisplayName(task)}
                </MuiLink>
              ))}
            </Stack>
          )}
        </PropertyRow>
        <PropertyRow label="Type">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Box
              sx={{
                display: "inline-flex",
                color: "text.secondary",
                "& svg": { fontSize: 16 },
              }}
            >
              <PlatformIcon platform={workItem.platform} fontSize="inherit" />
            </Box>
            <Typography variant="body2">
              {platformLabel(workItem.platform)}
            </Typography>
          </Stack>
        </PropertyRow>
        <PropertyRow label="Feeding agent">
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ color: pinnedCount ? "primary.main" : "text.secondary" }}
          >
            <BoltIcon sx={{ fontSize: 15 }} />
            <Typography variant="body2" color="inherit">
              {pinnedCount === undefined
                ? "—"
                : `${String(pinnedCount)} ${pinnedCount === 1 ? "comment" : "comments"}`}
            </Typography>
          </Stack>
        </PropertyRow>
        <PropertyRow label="Pipeline runs">
          {executionsData.loading ? (
            <Muted>—</Muted>
          ) : latestRun ? (
            <Stack spacing={0.25}>
              <Stack direction="row" spacing={0.75} alignItems="center">
                <ExecutionStatusIcon status={latestRun.status} />
                <MuiLink
                  component={Link}
                  href={projectPath("runs", latestRun.id)}
                  variant="body2"
                  underline="hover"
                  color="inherit"
                  sx={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {latestPipelineName} ·{" "}
                  {getExecutionStatusLabel(latestRun.status)}
                </MuiLink>
              </Stack>
              <MuiLink
                component="button"
                type="button"
                variant="caption"
                underline="hover"
                aria-label="Open pipeline executions"
                onClick={onOpenExecutions}
                sx={{ alignSelf: "flex-start" }}
              >
                {executionsData.total}{" "}
                {executionsData.total === 1 ? "run" : "runs"}
              </MuiLink>
            </Stack>
          ) : (
            <MuiLink
              component="button"
              type="button"
              variant="body2"
              underline="hover"
              aria-label="Open pipeline executions"
              onClick={onOpenExecutions}
              sx={{ alignSelf: "flex-start" }}
            >
              No runs
            </MuiLink>
          )}
        </PropertyRow>
      </Stack>

      <WorkItemSidebarRelationships
        projectId={projectId}
        workItem={workItem}
        onWorkItemChanged={onWorkItemChanged}
      />

      <Divider />

      <Stack spacing={1}>
        <PropertyRow label="Created">
          <Typography variant="body2">
            {formatDateTime(workItem.sourceCreatedAt ?? workItem.createdAt)}
          </Typography>
        </PropertyRow>
        <PropertyRow label="Updated">
          <Typography variant="body2">
            {formatDateTime(workItem.sourceUpdatedAt ?? workItem.updatedAt)}
          </Typography>
        </PropertyRow>
        <PropertyRow label="Synced">
          <Typography variant="body2">
            {formatDateTime(workItem.createdAt)}
          </Typography>
        </PropertyRow>
        <PropertyRow label="Source">
          {workItem.url ? (
            <MuiLink
              href={workItem.url}
              target="_blank"
              rel="noreferrer"
              variant="body2"
              underline="hover"
              sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
            >
              {workItem.platformKey}
              <OpenInNewIcon sx={{ fontSize: 14 }} />
            </MuiLink>
          ) : (
            <Typography
              variant="body2"
              sx={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}
            >
              {workItem.platformId ?? workItem.platformKey}
            </Typography>
          )}
        </PropertyRow>
      </Stack>

      <Box>
        <StartTaskButton projectId={projectId} workItemId={workItem.id} />
      </Box>

      <FieldsDisclosure fields={workItem.fields} />
    </Stack>
  );
}

function FieldsDisclosure({ fields }: { fields: WorkItemContract["fields"] }) {
  const [open, setOpen] = useState(false);
  if (!fields || Object.keys(fields).length === 0) return null;
  return (
    <Stack spacing={1}>
      <Button
        size="small"
        color="inherit"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        endIcon={
          <ExpandMoreIcon
            sx={{
              transition: "transform 120ms ease",
              transform: open ? "rotate(180deg)" : "none",
            }}
          />
        }
        sx={{
          alignSelf: "flex-start",
          textTransform: "none",
          color: "text.secondary",
        }}
      >
        {open ? "Hide fields" : "Show fields"}
      </Button>
      {open ? (
        <Box
          component="pre"
          sx={{
            m: 0,
            fontSize: "0.75rem",
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            color: "text.secondary",
          }}
        >
          {JSON.stringify(fields, null, 2)}
        </Box>
      ) : null}
    </Stack>
  );
}
