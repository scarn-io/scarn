"use client";

import { Alert, Box, ButtonBase, CircularProgress, Stack } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { useCallback, useMemo, useState } from "react";
import type {
  NodeVisitContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import { computeNodeVisualStatus } from "@/components/pipeline-graph/pipeline-graph-node-status";
import { PipelineGraphView } from "@/components/pipeline-graph/pipeline-graph-view";
import { usePipelineGraphSpec } from "@/components/pipeline-graph/use-pipeline-graph-spec";
import type { RailMode } from "./execution-detail-params";
import { landingVisit } from "./landing-visit";
import { overruleEdgeMarks } from "./overrule-routes";
import { RUN_RAIL_WIDTH } from "./layout-constants";
import { VisitTimeline } from "./visit-timeline";
import type { VisitTimelineEntry } from "./visit-timeline-entries";

const RAIL_MODES: readonly { value: RailMode; label: string }[] = [
  { value: "list", label: "List" },
  { value: "graph", label: "Graph" },
];

function RailToggle({
  value,
  onChange,
}: {
  value: RailMode;
  onChange: (mode: RailMode) => void;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      sx={{
        px: 2,
        py: 0.75,
        borderBottom: 1,
        borderColor: "divider",
        color: "text.secondary",
      }}
    >
      <Box
        component="span"
        sx={{ flex: 1, typography: "caption", fontWeight: 600 }}
      >
        Steps
      </Box>
      <Stack
        direction="row"
        role="radiogroup"
        aria-label="Show steps as"
        sx={{ p: 0.25, borderRadius: 1.5, border: 1, borderColor: "divider" }}
      >
        {RAIL_MODES.map((mode) => {
          const on = value === mode.value;
          return (
            <ButtonBase
              key={mode.value}
              role="radio"
              aria-checked={on}
              onClick={() => {
                onChange(mode.value);
              }}
              sx={{
                px: 1.25,
                py: 0.25,
                borderRadius: 1,
                typography: "caption",
                fontWeight: on ? 600 : 400,
                color: on ? "text.primary" : "text.secondary",
                backgroundColor: (theme: Theme) =>
                  on ? alpha(theme.palette.text.primary, 0.1) : "transparent",
                "&.Mui-focusVisible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                },
              }}
            >
              {mode.label}
            </ButtonBase>
          );
        })}
      </Stack>
    </Stack>
  );
}

function RunGraph({
  version,
  versionFailed,
  visits,
  highlightedNodeId,
  onSelectNode,
}: {
  version: PipelineVersionContract | null;
  versionFailed: boolean;
  visits: readonly NodeVisitContract[];
  highlightedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { nodes, edges, loading, error } = usePipelineGraphSpec(
    version,
    versionFailed,
  );
  const getNodeStatus = useCallback(
    (nodeId: string) => computeNodeVisualStatus(nodeId, visits),
    [visits],
  );
  const edgeMarks = useMemo(() => overruleEdgeMarks(visits), [visits]);
  if (loading) {
    return (
      <Box sx={{ height: "100%", display: "grid", placeItems: "center" }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (error) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error}
      </Alert>
    );
  }
  return (
    <PipelineGraphView
      nodes={nodes}
      edges={edges}
      getNodeStatus={getNodeStatus}
      highlightedNodeId={highlightedNodeId}
      onSelectNode={onSelectNode}
      edgeMarks={edgeMarks}
    />
  );
}

/**
 * A node's most relevant visit, as a run lands: what's waiting, running or
 * crashed there, else its last live visit, else its last.
 */
export function nodeLandingVisit(
  visits: readonly NodeVisitContract[],
  nodeId: string,
): NodeVisitContract | null {
  return landingVisit({
    visits: visits.filter((visit) => visit.nodeId === nodeId),
  });
}

/**
 * A pipeline run's left rail, from `md` up: a "Steps" bar switching between the visit
 * timeline (List) and the pipeline graph above that timeline (Graph).
 * Hovering a visit highlights its node; clicking a node selects its most
 * relevant visit.
 */
export function RunRail({
  mode,
  onModeChange,
  entries,
  selectedVisitId,
  onSelectVisit,
  version,
  versionFailed,
  visits,
}: {
  mode: RailMode;
  onModeChange: (mode: RailMode) => void;
  entries: readonly VisitTimelineEntry[];
  selectedVisitId: string | null;
  onSelectVisit: (visit: NodeVisitContract) => void;
  version: PipelineVersionContract | null;
  versionFailed: boolean;
  visits: readonly NodeVisitContract[];
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const selectedNodeId =
    entries.find((entry) => entry.visit.id === selectedVisitId)?.visit.nodeId ??
    null;
  return (
    <Box
      component="aside"
      sx={{
        display: { xs: "none", md: "flex" },
        flexDirection: "column",
        width: RUN_RAIL_WIDTH[mode],
        flexShrink: 0,
        minHeight: 0,
        borderRight: 1,
        borderColor: "divider",
        backgroundColor: "background.paper",
      }}
    >
      <RailToggle value={mode} onChange={onModeChange} />
      {mode === "graph" ? (
        <Box
          data-testid="run-rail-graph"
          sx={{
            flex: "1 1 58%",
            minHeight: 240,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <RunGraph
            version={version}
            versionFailed={versionFailed}
            visits={visits}
            highlightedNodeId={hoveredNodeId ?? selectedNodeId}
            onSelectNode={(nodeId) => {
              const visit = nodeLandingVisit(visits, nodeId);
              if (visit) onSelectVisit(visit);
            }}
          />
        </Box>
      ) : null}
      <Box sx={{ flex: "1 1 42%", minHeight: 0, overflowY: "auto" }}>
        <VisitTimeline
          entries={entries}
          selectedVisitId={selectedVisitId}
          onSelect={(entry) => {
            onSelectVisit(entry.visit);
          }}
          onHover={setHoveredNodeId}
        />
      </Box>
    </Box>
  );
}
