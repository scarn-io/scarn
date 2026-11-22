"use client";

import { Fragment } from "react";
import { Link as MuiLink, Stack, Tooltip, Typography } from "@mui/material";
import type { ChildWorkItemContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { Elapsed } from "@/components/executions/elapsed";
import { formatRelativeTime } from "@/components/executions/format-datetime";
import { ChildWorkItemStatusIcon } from "./child-work-item-status-icon";
import { MemberAvatar, memberLabel } from "./work-item-assignee";
import { RelationshipActionsMenu } from "./work-item-relationship-row";
import { WorkItemLabelChips } from "./work-items-table";

const ONE_LINE_SX = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

function SecondLine({
  children,
  color = "text.secondary",
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ ...ONE_LINE_SX, color, pl: 3 }}
    >
      {children}
    </Typography>
  );
}

/**
 * What a Needs a person child is waiting for, in order: the question its
 * Task handed over, "Ready for review" (its Task waits for a person without
 * a question, so the work is done and wants a look), the failure, a cancel,
 * or nothing started at all.
 */
function NeedsPersonLine({
  latestTask,
}: {
  latestTask: ChildWorkItemContract["latestTask"];
}) {
  if (latestTask === null) {
    return (
      <SecondLine>
        Nothing started · do this by hand, or start a step
      </SecondLine>
    );
  }
  if (latestTask.question) {
    return <SecondLine>{latestTask.question}</SecondLine>;
  }
  if (latestTask.status === "waiting_for_person") {
    return <SecondLine>Ready for review</SecondLine>;
  }
  const age = formatRelativeTime(latestTask.updatedAt);
  if (latestTask.status === "failed") {
    return (
      <SecondLine color="error.main">
        Run failed: {latestTask.failure ?? "no error message"} · {age}
      </SecondLine>
    );
  }
  return <SecondLine>Run cancelled · {age}</SecondLine>;
}

const WAITING_RUNNING_LABELS: Partial<
  Record<NonNullable<ChildWorkItemContract["latestTask"]>["status"], string>
> = {
  queued: "queued",
  waiting_for_concurrency_slot: "waiting for a concurrency slot",
  waiting_for_work: "waiting for its blockers",
};

function RunningLine({
  latestTask,
}: {
  latestTask: NonNullable<ChildWorkItemContract["latestTask"]>;
}) {
  const step = latestTask.step?.name ?? "Task";
  const waiting = WAITING_RUNNING_LABELS[latestTask.status];
  if (waiting || !latestTask.startedAt) {
    return (
      <SecondLine>
        {step} · {waiting ?? "starting"}
      </SecondLine>
    );
  }
  return (
    <SecondLine>
      {step} · running for{" "}
      <Elapsed startedAt={latestTask.startedAt} completedAt={null} isRunning />
    </SecondLine>
  );
}

function BlockedLine({
  blockers,
}: {
  blockers: ChildWorkItemContract["openBlockers"];
}) {
  const projectPath = useProjectPath();
  return (
    <SecondLine>
      Blocked by{" "}
      {blockers.map((blocker, index) => (
        <Fragment key={blocker.id}>
          {index > 0 ? ", " : null}
          <MuiLink
            href={projectPath("work-items", blocker.id)}
            underline="hover"
            color="inherit"
          >
            {blocker.title}
          </MuiLink>
        </Fragment>
      ))}
    </SecondLine>
  );
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

function ChildSecondLine({ child }: { child: ChildWorkItemContract }) {
  switch (child.status) {
    case "needs_person":
      return <NeedsPersonLine latestTask={child.latestTask} />;
    case "running":
      return child.latestTask ? (
        <RunningLine latestTask={child.latestTask} />
      ) : null;
    case "blocked":
      return child.openBlockers.length > 0 ? (
        <BlockedLine blockers={child.openBlockers} />
      ) : null;
    case "closed":
      return child.resolution ? (
        <SecondLine>{oneLine(child.resolution)}</SecondLine>
      ) : null;
    case "ready":
      return null;
  }
}

/**
 * One row of the child work items section: the status icon, title, label
 * chips, assignee and a "..." menu, then a line saying where it stands.
 */
export function WorkItemChildRow({
  child,
  canManage,
  disabled,
  onRemove,
}: {
  child: ChildWorkItemContract;
  canManage: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const projectPath = useProjectPath();
  const href = projectPath("work-items", child.id);

  return (
    <Stack spacing={0.25} data-testid="child-work-item-row">
      <Stack direction="row" spacing={1} alignItems="center">
        <ChildWorkItemStatusIcon status={child.status} />
        <Stack
          direction="row"
          alignItems="center"
          sx={{ flexGrow: 1, minWidth: 0 }}
        >
          <MuiLink
            href={href}
            variant="body2"
            underline="hover"
            sx={ONE_LINE_SX}
          >
            {child.title}
          </MuiLink>
          <WorkItemLabelChips labels={child.labels} />
        </Stack>
        {child.assignee ? (
          <Tooltip title={memberLabel(child.assignee)}>
            <span aria-label={`Assigned to ${memberLabel(child.assignee)}`}>
              <MemberAvatar member={child.assignee} />
            </span>
          </Tooltip>
        ) : null}
        <RelationshipActionsMenu
          href={href}
          canManage={canManage}
          removeLabel="Remove"
          onRemove={onRemove}
          disabled={disabled}
          label="Child work item actions"
        />
      </Stack>
      <ChildSecondLine child={child} />
    </Stack>
  );
}
