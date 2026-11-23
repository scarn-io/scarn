"use client";

/**
 * Small pieces of a Runs row: the kind icon, the work item key link, the
 * schedule a scheduled Task belongs to, who started it, when it was
 * updated, and the text helpers behind them.
 */

import { Box, Typography } from "@mui/material";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import AssignmentOutlinedIcon from "@mui/icons-material/AssignmentOutlined";
import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import Link from "next/link";
import type { ElementType, ReactNode } from "react";
import type { ProjectRunType } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { formatDateTime } from "@/components/executions/format-datetime";
import { useProjectPath } from "@/components/project-route-context";
import type { ProjectRun } from "./runs-api";
import { runsNavHref } from "./runs-params";

const KIND_ICON: Record<ProjectRunType, ElementType> = {
  pipeline: AccountTreeOutlinedIcon,
  step: BoltOutlinedIcon,
  task: AssignmentOutlinedIcon,
};

const KIND_TITLE: Record<ProjectRunType, string> = {
  pipeline: "Pipeline run",
  step: "A single step, started on its own",
  task: "A Task you asked for",
};

/** One icon per kind of run, so the eye can sort pipelines from asks. */
export function KindIcon({ kind }: { kind: ProjectRunType }) {
  const Icon = KIND_ICON[kind];
  return (
    <Box
      component="span"
      title={KIND_TITLE[kind]}
      sx={{
        display: "inline-flex",
        verticalAlign: "-2px",
        mr: 0.5,
        color: "text.disabled",
      }}
    >
      <Icon sx={{ fontSize: 13 }} />
    </Box>
  );
}

/**
 * A work item key linking to the work item. It sits above the row's
 * stretched link, so clicking it opens the item rather than the run.
 */
export function ItemKey({ itemKey, href }: { itemKey: string; href: string }) {
  return (
    <Box
      component={Link}
      href={href}
      title={`Open ${itemKey}`}
      onClick={(event: React.MouseEvent) => {
        event.stopPropagation();
      }}
      sx={{
        position: "relative",
        zIndex: 1,
        color: "primary.main",
        textDecoration: "none",
        "&:hover": { textDecoration: "underline" },
      }}
    >
      {itemKey}
    </Box>
  );
}

type ScheduleStarter = Extract<ProjectRun["startedBy"], { kind: "schedule" }>;

/** `<automation title or key> · <rule key>`. */
export const scheduleLabel = (startedBy: ScheduleStarter): string =>
  `${startedBy.title ?? startedBy.key} · ${startedBy.schedule.key}`;

/** The Runs list scoped to one schedule's Tasks: its history. */
export function useScheduleHistoryHref(): (scheduleId: string) => string {
  const buildPath = useProjectPath();
  return (scheduleId) =>
    runsNavHref(buildPath("runs"), { status: "all", schedule: scheduleId });
}

export function ScheduleIcon({ title }: { title?: string }) {
  return (
    <Box
      component="span"
      title={title}
      sx={{
        display: "inline-flex",
        verticalAlign: "-2px",
        mr: 0.5,
        color: "text.disabled",
      }}
    >
      <ScheduleOutlinedIcon sx={{ fontSize: 13 }} />
    </Box>
  );
}

/** Marks a schedule rule since removed from its automation. */
export function RemovedBadge() {
  return (
    <Box
      component="span"
      data-testid="schedule-removed"
      title="This schedule rule was removed from the automation"
      sx={{
        ml: 0.75,
        px: 0.5,
        borderRadius: 0.75,
        fontSize: 10.5,
        fontWeight: 500,
        verticalAlign: "middle",
        color: "text.disabled",
        border: 1,
        borderColor: "divider",
      }}
    >
      removed
    </Box>
  );
}

/**
 * The schedule a scheduled Task belongs to, linking to its history. Like
 * {@link ItemKey} it sits above the row's stretched link.
 */
export function ScheduleRef({ startedBy }: { startedBy: ScheduleStarter }) {
  const historyHref = useScheduleHistoryHref();
  const label = scheduleLabel(startedBy);
  return (
    <Box component="span" data-testid="schedule-ref">
      <ScheduleIcon title="Started on a schedule" />
      <Box
        component={Link}
        href={historyHref(startedBy.schedule.id)}
        title={`Runs of ${label}`}
        onClick={(event: React.MouseEvent) => {
          event.stopPropagation();
        }}
        sx={{
          position: "relative",
          zIndex: 1,
          color: "primary.main",
          textDecoration: "none",
          "&:hover": { textDecoration: "underline" },
        }}
      >
        {label}
      </Box>
      {startedBy.schedule.removed ? <RemovedBadge /> : null}
    </Box>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}
    >
      {children}
    </Box>
  );
}

/** The person who used Run now, from the viewer's side. */
export const runNowByText = (
  user: NonNullable<ScheduleStarter["user"]>,
  viewerUserId: string | null,
): string =>
  viewerUserId !== null && user.userId === viewerUserId
    ? "you"
    : (user.username ?? "Unknown user");

/** Who started a run, from the viewer's side: their own runs read "you". */
export function startedByText(
  startedBy: ProjectRun["startedBy"],
  viewerUserId: string | null,
): string {
  switch (startedBy.kind) {
    case "user":
      if (viewerUserId !== null && startedBy.userId === viewerUserId) {
        return "you";
      }
      return startedBy.username ?? "Unknown user";
    case "automation":
      return startedBy.title ?? startedBy.key;
    case "schedule": {
      const label = `${scheduleLabel(startedBy)}${
        startedBy.schedule.removed ? " (removed)" : ""
      }`;
      if (startedBy.user === null) return label;
      return `Run now by ${runNowByText(startedBy.user, viewerUserId)} · ${label}`;
    }
    case "system":
      return "System";
  }
}

/** Automations and other people by name; the viewer's own runs as a quieter "you". */
export function StartedBy({
  startedBy,
  viewerUserId,
}: {
  startedBy: ProjectRun["startedBy"];
  viewerUserId: string | null;
}) {
  if (startedBy.kind === "schedule") {
    return (
      <Box component="span" data-started-by="schedule">
        <ScheduleIcon title="Started on a schedule" />
        {startedBy.user === null
          ? "Schedule"
          : `Run now by ${runNowByText(startedBy.user, viewerUserId)}`}
      </Box>
    );
  }
  const text = startedByText(startedBy, viewerUserId);
  const quiet = text === "you" || startedBy.kind === "system";
  return (
    <Box
      component="span"
      data-started-by={startedBy.kind}
      sx={quiet ? { color: "text.disabled" } : undefined}
    >
      {text}
    </Box>
  );
}

const namesOf = (people: ProjectRun["waitingOn"]): string => {
  const names = people.map((person) => person.username ?? "someone");
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${String(names.length - 2)} more`;
};

/**
 * The run's one-line status. A run waiting on other people names them,
 * keeping the server's line when it adds something (e.g. the question).
 */
export function runStatusText(run: ProjectRun): string {
  const line = run.statusLine.replace(/\s+/g, " ").trim();
  if (run.status !== "waiting" || run.waitingOn.length === 0) return line;
  const who = `Waiting on ${namesOf(run.waitingOn)}`;
  return line && !line.startsWith("Waiting") ? `${who} · ${line}` : who;
}

const COMPACT_STEPS = [
  { limitMs: 3_600_000, divisorMs: 60_000, suffix: "m" },
  { limitMs: 86_400_000, divisorMs: 3_600_000, suffix: "h" },
  { limitMs: 7 * 86_400_000, divisorMs: 86_400_000, suffix: "d" },
];

const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

/** "now", "5m", "3h", "2d", then "Jun 24": fits the narrow Updated column. */
export function compactAge(value: string, now: number = Date.now()): string {
  const date = new Date(value);
  const ageMs = now - date.getTime();
  if (Number.isNaN(ageMs)) return "—";
  if (ageMs < 60_000) return "now";
  for (const step of COMPACT_STEPS) {
    if (ageMs < step.limitMs) {
      return `${String(Math.floor(ageMs / step.divisorMs))}${step.suffix}`;
    }
  }
  return SHORT_DATE.format(date);
}

export function Updated({ value }: { value: string }) {
  return (
    <Typography
      variant="caption"
      component="time"
      dateTime={value}
      title={`Updated ${formatDateTime(value)}`}
      sx={{ color: "text.disabled", textAlign: "right", pt: 0.25 }}
    >
      {compactAge(value)}
    </Typography>
  );
}
