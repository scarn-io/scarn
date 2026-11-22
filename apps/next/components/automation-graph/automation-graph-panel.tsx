"use client";

import { useMemo } from "react";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import {
  buildAutomationRound,
  type AutomationRoundModel,
  type RoundEdgeTone,
} from "@scarn/pipeline-studio-ui";
import {
  AutomationRoundView,
  ROUND_EDGE_COLOR,
  ROUND_EDGE_DASH,
} from "@scarn/pipeline-studio-ui/view";
import type { Grant } from "@scarn/sdk/definitions/steps";
import { Alert, Box, Chip, Paper, Stack, Typography } from "@mui/material";
import { PIPELINE_GRAPH_HEIGHT } from "@/components/executions/layout-constants";
import { PipelineEmptyState } from "@/components/pipelines/pipeline-execution-table/empty-state";
import { formatTimestamp } from "@/components/pipelines/pipeline-execution-table/helpers";

type GraphResult =
  | { status: "unpublished" }
  | { status: "error"; message: string }
  | { status: "ready"; model: AutomationRoundModel };

function buildRound(
  automation: AutomationContract,
  stepGrants: ReadonlyMap<string, readonly Grant[]>,
  pipelineNames: ReadonlyMap<string, string>,
): GraphResult {
  const document = automation.latestVersion?.document;
  if (document === undefined) return { status: "unpublished" };
  try {
    return {
      status: "ready",
      model: buildAutomationRound(
        { key: automation.key, document },
        stepGrants,
        pipelineNames,
      ),
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const LEGEND: readonly { tone: RoundEdgeTone; label: string }[] = [
  { tone: "route", label: "Route" },
  { tone: "declared", label: "Soft link (step grants)" },
  { tone: "engine", label: "Engine" },
];

function RoundLegend() {
  return (
    <Stack
      direction="row"
      spacing={2}
      flexWrap="wrap"
      useFlexGap
      aria-label="Edge legend"
    >
      {LEGEND.map(({ tone, label }) => (
        <Stack key={tone} direction="row" spacing={0.75} alignItems="center">
          <svg width="22" height="6" aria-hidden>
            <line
              x1="0"
              y1="3"
              x2="22"
              y2="3"
              stroke={ROUND_EDGE_COLOR[tone]}
              strokeWidth="1.5"
              strokeDasharray={ROUND_EDGE_DASH[tone]}
            />
          </svg>
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * One automation's header and the read-only round graph of its latest
 * version: routes the document declares, plus soft links drawn from its
 * steps' grants.
 */
export function AutomationGraphPanel({
  automation,
  pipelineNames,
  stepGrants,
}: {
  automation: AutomationContract;
  pipelineNames: ReadonlyMap<string, string>;
  stepGrants: ReadonlyMap<string, readonly Grant[]>;
}) {
  const version = automation.latestVersion;
  const graph = useMemo(
    () => buildRound(automation, stepGrants, pipelineNames),
    [automation, stepGrants, pipelineNames],
  );

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack spacing={3}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
        >
          <Typography variant="subtitle1">
            {automation.title ?? automation.key}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontFamily: "var(--font-mono)" }}
          >
            {automation.key}
          </Typography>
          {version ? (
            <Chip size="small" label={`v${String(version.version)}`} />
          ) : null}
          <Chip
            size="small"
            variant="outlined"
            label={
              automation.scope === "project"
                ? "Project automation"
                : "Work item automation"
            }
          />
          {automation.enabled ? null : (
            <Chip size="small" color="warning" label="Disabled" />
          )}
        </Stack>

        {graph.status === "unpublished" ? (
          <PipelineEmptyState
            title="No published version"
            description="Push the automation document from the CLI to publish its first version."
          />
        ) : graph.status === "error" ? (
          <Alert severity="error">{graph.message}</Alert>
        ) : graph.model.nodes.length === 0 ? (
          <PipelineEmptyState
            title="No rules"
            description="This version has no rules, so nothing routes."
          />
        ) : (
          <Stack spacing={1}>
            <Box
              sx={{
                height: PIPELINE_GRAPH_HEIGHT,
                border: 1,
                borderColor: "divider",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <AutomationRoundView model={graph.model} />
            </Box>
            <RoundLegend />
            <Typography variant="body2" color="text.secondary">
              Configured wiring from this automation&apos;s latest version.
              Read-only.
            </Typography>
          </Stack>
        )}

        {version ? (
          <Typography variant="caption" color="text.secondary">
            Published {formatTimestamp(version.publishedAt)}
          </Typography>
        ) : null}
      </Stack>
    </Paper>
  );
}
