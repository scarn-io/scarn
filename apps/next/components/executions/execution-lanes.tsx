"use client";

/**
 * The run overview's Lanes section: one block per lane group (an `each`
 * fan-out over items, or the routes a `match: "all"` node took), with a cell
 * per lane colored by the lane's status and named by `laneLabel`. A cell
 * opens the lane's latest visit.
 */

import {
  Box,
  ButtonBase,
  Chip,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { Theme } from "@mui/material";
import type {
  LaneContract,
  LaneGroupContract,
  NodeVisitContract,
  PipelineExecutionContract,
} from "@scarn/api/frontend-contracts";
import { lastMatching } from "./execution-step-items";
import type { StepNavSelection } from "./execution-detail-params";
import { laneLabel } from "./visit-labels";

type LaneStatus = LaneContract["status"];

const LANE_STATUS_LABELS: Record<LaneStatus, string> = {
  pending: "Pending",
  active: "Active",
  arrived: "Arrived at merge",
  ended: "Ended",
  failed: "Failed",
  cancelled: "Cancelled",
};

const LANE_LEGEND_ORDER: readonly LaneStatus[] = [
  "active",
  "pending",
  "arrived",
  "ended",
  "failed",
  "cancelled",
];

const laneColor = (theme: Theme, status: LaneStatus): string => {
  switch (status) {
    case "active":
      return theme.palette.primary.main;
    case "arrived":
    case "ended":
      return theme.palette.success.main;
    case "failed":
      return theme.palette.error.main;
    case "cancelled":
      return theme.palette.text.disabled;
    case "pending":
      return "transparent";
  }
};

const GROUP_STATUS_LABELS: Record<LaneGroupContract["status"], string> = {
  open: "Open",
  merged: "Merged",
  failed: "Failed",
};

const GROUP_STATUS_COLORS: Record<
  LaneGroupContract["status"],
  "primary" | "success" | "error"
> = {
  open: "primary",
  merged: "success",
  failed: "error",
};

function toleranceLabel(group: LaneGroupContract): string | null {
  const tolerated = group.toleratedFailures;
  if ("count" in tolerated) {
    return tolerated.count > 0
      ? `tolerates ${String(tolerated.count)} failed`
      : null;
  }
  return tolerated.percent > 0
    ? `tolerates ${String(tolerated.percent)}% failed`
    : null;
}

function previewItem(item: LaneContract["item"]): string {
  if (item === null) return "";
  const text = typeof item === "string" ? item : JSON.stringify(item);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function latestLaneVisit(
  visits: readonly NodeVisitContract[],
  laneId: string,
): NodeVisitContract | null {
  return (
    lastMatching(
      visits,
      (visit) => visit.laneId === laneId && visit.status !== "superseded",
    ) ?? lastMatching(visits, (visit) => visit.laneId === laneId)
  );
}

function LaneCell({
  lane,
  label,
  visit,
  nodeTitle,
  onSelect,
}: {
  lane: LaneContract;
  label: string;
  visit: NodeVisitContract | null;
  nodeTitle: (nodeId: string) => string;
  onSelect: (selection: StepNavSelection) => void;
}) {
  const item = previewItem(lane.item);
  const title = [
    `${label} · ${LANE_STATUS_LABELS[lane.status]}`,
    visit ? `at ${nodeTitle(visit.nodeId)}` : null,
    item || null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Tooltip title={<Box sx={{ whiteSpace: "pre-line" }}>{title}</Box>}>
      <span>
        <ButtonBase
          aria-label={`${label}: ${LANE_STATUS_LABELS[lane.status]}`}
          disabled={!visit}
          onClick={() => {
            if (visit) {
              onSelect({
                kind: "step",
                nodeId: visit.nodeId,
                visitId: visit.id,
              });
            }
          }}
          sx={{
            width: 28,
            height: 28,
            borderRadius: 1,
            border: 1.5,
            borderColor: (theme) =>
              lane.status === "pending"
                ? theme.palette.divider
                : laneColor(theme, lane.status),
            bgcolor: (theme) =>
              lane.status === "pending"
                ? "transparent"
                : `${laneColor(theme, lane.status)}${lane.status === "active" ? "33" : "26"}`,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "text.secondary",
            transition: "transform 120ms ease",
            "&:hover": { transform: "translateY(-1px)" },
            "&.Mui-focusVisible": {
              outline: 2,
              outlineColor: "primary.main",
              outlineOffset: 1,
            },
            "@media (prefers-reduced-motion: reduce)": {
              transition: "none",
              "&:hover": { transform: "none" },
            },
          }}
        >
          {lane.index + 1}
        </ButtonBase>
      </span>
    </Tooltip>
  );
}

function groupTitle(
  prefix: string,
  spawnedBy: NodeVisitContract | undefined,
  nodeTitle: (nodeId: string) => string,
): string {
  return spawnedBy ? `${prefix} from ${nodeTitle(spawnedBy.nodeId)}` : prefix;
}

function LaneGroupBlock({
  group,
  execution,
  nodeTitle,
  onSelect,
}: {
  group: LaneGroupContract;
  execution: PipelineExecutionContract;
  nodeTitle: (nodeId: string) => string;
  onSelect: (selection: StepNavSelection) => void;
}) {
  const lanes = execution.lanes
    .filter((lane) => lane.laneGroupId === group.id)
    .sort((left, right) => left.index - right.index);
  const spawnedBy = execution.visits.find(
    (visit) => visit.id === group.spawnedByVisitId,
  );
  const counts = new Map<LaneStatus, number>();
  for (const lane of lanes) {
    counts.set(lane.status, (counts.get(lane.status) ?? 0) + 1);
  }
  const isAll = group.kind === "all";
  const facts = [
    `${String(group.laneCount)} ${isAll ? "routes" : "items"}`,
    group.maxConcurrency !== null
      ? `${String(group.maxConcurrency)} at a time`
      : null,
    toleranceLabel(group),
  ].filter(Boolean);

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        px: 2,
        py: 1.5,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {groupTitle(isAll ? "All routes" : "Each", spawnedBy, nodeTitle)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {facts.join(" · ")}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={GROUP_STATUS_COLORS[group.status]}
          label={GROUP_STATUS_LABELS[group.status]}
          sx={{ ml: "auto" }}
        />
      </Stack>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
        {lanes.map((lane) => (
          <LaneCell
            key={lane.id}
            lane={lane}
            label={laneLabel(execution, lane, nodeTitle)}
            visit={latestLaneVisit(execution.visits, lane.id)}
            nodeTitle={nodeTitle}
            onSelect={onSelect}
          />
        ))}
      </Box>
      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        flexWrap="wrap"
        sx={{ mt: 1 }}
      >
        {LANE_LEGEND_ORDER.filter((status) => counts.has(status)).map(
          (status) => (
            <Stack
              key={status}
              direction="row"
              spacing={0.5}
              alignItems="center"
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: 0.5,
                  border: 1,
                  borderColor: (theme) =>
                    status === "pending"
                      ? theme.palette.divider
                      : laneColor(theme, status),
                  bgcolor: (theme) => laneColor(theme, status),
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {String(counts.get(status))}{" "}
                {LANE_STATUS_LABELS[status].toLowerCase()}
              </Typography>
            </Stack>
          ),
        )}
      </Stack>
    </Box>
  );
}

export function ExecutionLanes({
  execution,
  nodeTitle,
  onSelect,
}: {
  execution: PipelineExecutionContract;
  nodeTitle: (nodeId: string) => string;
  onSelect: (selection: StepNavSelection) => void;
}) {
  if (execution.laneGroups.length === 0) return null;
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Lanes
      </Typography>
      <Stack spacing={1.5}>
        {execution.laneGroups.map((group) => (
          <LaneGroupBlock
            key={group.id}
            group={group}
            execution={execution}
            nodeTitle={nodeTitle}
            onSelect={onSelect}
          />
        ))}
      </Stack>
    </Box>
  );
}
