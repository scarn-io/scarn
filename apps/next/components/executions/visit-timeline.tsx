"use client";

import { Box, ButtonBase, Stack, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { useState } from "react";
import { Elapsed } from "./elapsed";
import { StepRunStatusIcon } from "./step-run-status-icon";
import { visitTiming } from "./visit-labels";
import type { VisitDisplayStatus } from "./visit-status";
import type { VisitTimelineEntry } from "./visit-timeline-entries";

const LOUD_COLOR: Partial<Record<VisitDisplayStatus, string>> = {
  waiting: "warning.main",
  failed: "error.main",
  timeout: "error.main",
  abandoned: "warning.main",
};

function TimelineRow({
  entry,
  active,
  sameNode,
  last,
  onSelect,
  onHover,
}: {
  entry: VisitTimelineEntry;
  active: boolean;
  sameNode: boolean;
  last: boolean;
  onSelect: () => void;
  onHover: (nodeId: string | null) => void;
}) {
  const { visit, status } = entry;
  const superseded = status === "superseded";
  const loudColor = LOUD_COLOR[status];
  const timing = visitTiming(visit);
  return (
    <Box component="li">
      <ButtonBase
        onClick={onSelect}
        onMouseEnter={() => {
          onHover(visit.nodeId);
        }}
        onMouseLeave={() => {
          onHover(null);
        }}
        aria-current={active ? "step" : undefined}
        sx={{
          width: "100%",
          display: "grid",
          gridTemplateColumns: "22px minmax(0, 1fr) auto",
          columnGap: 1.25,
          alignItems: "start",
          textAlign: "left",
          pl: entry.inLane ? 3.5 : 2,
          pr: 2,
          py: 0.875,
          opacity: superseded ? 0.55 : 1,
          backgroundColor: (theme: Theme) =>
            active
              ? alpha(theme.palette.text.primary, 0.08)
              : sameNode
                ? alpha(theme.palette.text.primary, 0.03)
                : "transparent",
          boxShadow: (theme: Theme) =>
            active ? `inset 2px 0 0 ${theme.palette.primary.main}` : "none",
          "&:hover": {
            backgroundColor: (theme: Theme) =>
              alpha(theme.palette.text.primary, 0.06),
          },
          "&.Mui-focusVisible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: -2,
          },
        }}
      >
        <Box
          sx={{
            position: "relative",
            alignSelf: "stretch",
            display: "flex",
            justifyContent: "center",
          }}
        >
          {last ? null : (
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                top: 24,
                bottom: -12,
                width: "1px",
                backgroundColor: "divider",
              }}
            />
          )}
          <StepRunStatusIcon status={status} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="div"
            variant="body2"
            sx={{
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              fontWeight: active || loudColor ? 600 : 400,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textDecoration: superseded ? "line-through" : "none",
            }}
          >
            {entry.inLane ? (
              <Box component="span" aria-hidden sx={{ color: "text.disabled" }}>
                ⑂{" "}
              </Box>
            ) : null}
            {entry.label}
          </Typography>
          <Typography
            component="div"
            variant="caption"
            sx={{
              color: loudColor ?? "text.secondary",
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.note}
            {entry.mergedLanes > 1
              ? ` · merges ${String(entry.mergedLanes)} lanes`
              : ""}
          </Typography>
        </Box>
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{
            pt: 0.25,
            fontFamily: "var(--font-mono)",
            whiteSpace: "nowrap",
          }}
        >
          {timing ? (
            <Elapsed
              startedAt={timing.startedAt}
              completedAt={timing.completedAt}
              isRunning={status === "running"}
            />
          ) : null}
        </Typography>
      </ButtonBase>
    </Box>
  );
}

/**
 * Every visit of a run in the order it happened: loops, lanes (indented,
 * marked ⑂) and the visits a rerun superseded (struck through, hideable).
 */
export function VisitTimeline({
  entries,
  selectedVisitId,
  onSelect,
  onHover = () => {},
}: {
  entries: readonly VisitTimelineEntry[];
  selectedVisitId: string | null;
  onSelect: (entry: VisitTimelineEntry) => void;
  onHover?: (nodeId: string | null) => void;
}) {
  const [showSuperseded, setShowSuperseded] = useState(true);
  const supersededCount = entries.filter(
    (entry) => entry.status === "superseded",
  ).length;
  const shown = entries.filter(
    (entry) => showSuperseded || entry.status !== "superseded",
  );
  const selectedNodeId =
    entries.find((entry) => entry.visit.id === selectedVisitId)?.visit.nodeId ??
    null;
  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" alignItems="baseline" sx={{ px: 2, mb: 0.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontWeight: 600, flex: 1 }}
        >
          {entries.length === 1
            ? "1 step"
            : `${String(entries.length)} steps, oldest first`}
        </Typography>
        {supersededCount > 0 ? (
          <ButtonBase
            onClick={() => {
              setShowSuperseded((show) => !show);
            }}
            sx={{
              typography: "caption",
              color: "text.secondary",
              "&:hover": { color: "text.primary" },
            }}
          >
            {showSuperseded ? "Hide" : "Show"} {supersededCount} superseded
          </ButtonBase>
        ) : null}
      </Stack>
      {entries.length === 0 ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ px: 2, py: 1 }}
        >
          No steps have run yet.
        </Typography>
      ) : (
        <Box
          component="ol"
          aria-label="Steps"
          sx={{ listStyle: "none", m: 0, p: 0 }}
        >
          {shown.map((entry, index) => (
            <TimelineRow
              key={entry.visit.id}
              entry={entry}
              active={entry.visit.id === selectedVisitId}
              sameNode={
                entry.visit.id !== selectedVisitId &&
                entry.visit.nodeId === selectedNodeId
              }
              last={index === shown.length - 1}
              onSelect={() => {
                onSelect(entry);
              }}
              onHover={onHover}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
