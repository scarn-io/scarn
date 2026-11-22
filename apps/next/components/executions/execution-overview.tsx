"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import { Elapsed } from "./elapsed";
import { ExecutionLanes } from "./execution-lanes";
import { startVisit } from "./execution-step-action-guards";
import type { ExecutionStepItem } from "./execution-step-items";
import type { StepNavSelection } from "./execution-detail-params";
import { formatDateTime } from "./format-datetime";
import { JsonBlock } from "./json-block";
import {
  PIPELINE_GRAPH_EXPANDED_INSET,
  PIPELINE_GRAPH_HEIGHT,
} from "./layout-constants";
import { usePipelineGraphSpec } from "@/components/pipeline-graph/use-pipeline-graph-spec";
import { PipelineGraphView } from "@/components/pipeline-graph/pipeline-graph-view";
import { computeNodeVisualStatus } from "@/components/pipeline-graph/pipeline-graph-node-status";
import type {
  PipelineExecutionContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";

export function ExecutionOverview({
  execution,
  version,
  versionFailed,
  steps,
  onSelect,
}: {
  execution: PipelineExecutionContract;
  /** The run's pinned version; `null` while it loads or if it failed. */
  version: PipelineVersionContract | null;
  versionFailed: boolean;
  steps: readonly ExecutionStepItem[];
  onSelect: (selection: StepNavSelection) => void;
}) {
  const {
    nodes,
    edges,
    loading: graphLoading,
    error: graphError,
  } = usePipelineGraphSpec(version, versionFailed);

  const [isGraphExpanded, setIsGraphExpanded] = useState(false);
  const visits = execution.visits;
  const getNodeStatus = useCallback(
    (nodeId: string) => computeNodeVisualStatus(nodeId, visits),
    [visits],
  );
  const isRunning = execution.status === "running";
  const input = startVisit(execution)?.input ?? null;
  const visitedNodes = steps.filter((step) => step.visits.length > 0).length;
  const openNodes = steps.filter(
    (step) => step.status === "running" || step.status === "queued",
  );
  const nodeTitle = (nodeId: string) =>
    steps.find((step) => step.nodeId === nodeId)?.title ?? nodeId;

  // A CSS-state "expand" rather than the browser Fullscreen API, so ESC is
  // wired up here.
  useEffect(() => {
    if (!isGraphExpanded) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsGraphExpanded(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isGraphExpanded]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h6" sx={{ mb: 1 }}>
          Run overview
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {`Started ${formatDateTime(execution.startedAt ?? execution.createdAt)} · `}
          <Elapsed
            startedAt={execution.startedAt}
            completedAt={execution.completedAt}
            endedAt={execution.updatedAt}
            isRunning={isRunning}
          />
          {isRunning ? " elapsed" : ""}
          {` · ${String(visitedNodes)} of ${String(steps.length)} nodes visited`}
          {isRunning && openNodes.length > 0
            ? ` · running ${openNodes.map((step) => step.title).join(", ")}`
            : ""}
        </Typography>
        {execution.error ? (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {execution.error.name}: {execution.error.message}
          </Alert>
        ) : null}
      </Box>

      {input !== null && Object.keys(input).length > 0 ? (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Pipeline input
          </Typography>
          <JsonBlock value={input} />
        </Box>
      ) : null}

      <Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 1,
            // Lift the header above the expanded backdrop so its toggle stays
            // clickable.
            ...(isGraphExpanded
              ? {
                  position: "relative",
                  zIndex: (theme) => theme.zIndex.modal + 2,
                }
              : {}),
          }}
        >
          <Typography variant="subtitle2">Pipeline graph</Typography>
          <Tooltip title={isGraphExpanded ? "Collapse" : "Expand"}>
            <IconButton
              size="small"
              aria-label={
                isGraphExpanded
                  ? "Collapse pipeline graph"
                  : "Expand pipeline graph"
              }
              onClick={() => {
                setIsGraphExpanded((expanded) => !expanded);
              }}
            >
              {isGraphExpanded ? (
                <FullscreenExitIcon fontSize="small" />
              ) : (
                <FullscreenIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Box>

        {isGraphExpanded ? (
          <Box
            onClick={() => {
              setIsGraphExpanded(false);
            }}
            sx={{
              position: "fixed",
              inset: 0,
              bgcolor: "rgba(0, 0, 0, 0.5)",
              zIndex: (theme) => theme.zIndex.modal,
            }}
          />
        ) : null}

        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            overflow: "hidden",
            bgcolor: "background.paper",
            ...(isGraphExpanded
              ? {
                  position: "fixed",
                  inset: PIPELINE_GRAPH_EXPANDED_INSET,
                  zIndex: (theme) => theme.zIndex.modal + 1,
                  boxShadow: 8,
                }
              : { height: PIPELINE_GRAPH_HEIGHT }),
            ...(graphLoading || graphError
              ? {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }
              : {}),
          }}
        >
          {isGraphExpanded ? (
            <Tooltip title="Collapse">
              <IconButton
                size="small"
                aria-label="Collapse pipeline graph"
                onClick={() => {
                  setIsGraphExpanded(false);
                }}
                sx={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  zIndex: 1,
                  bgcolor: "background.paper",
                  border: 1,
                  borderColor: "divider",
                  "&:hover": { bgcolor: "background.paper" },
                }}
              >
                <FullscreenExitIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
          {graphLoading ? (
            <CircularProgress size={28} />
          ) : graphError ? (
            <Alert severity="error" sx={{ width: "100%" }}>
              {graphError}
            </Alert>
          ) : (
            <PipelineGraphView
              nodes={nodes}
              edges={edges}
              getNodeStatus={getNodeStatus}
              onSelectNode={(nodeId) => {
                if (steps.some((step) => step.nodeId === nodeId)) {
                  onSelect({ kind: "step", nodeId, visitId: null });
                }
              }}
              isExpanded={isGraphExpanded}
            />
          )}
        </Box>
      </Box>

      <ExecutionLanes
        execution={execution}
        nodeTitle={nodeTitle}
        onSelect={onSelect}
      />
    </Stack>
  );
}
