"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import type { PipelineDefinitionContract } from "@scarn/api/frontend-contracts";
import {
  Alert,
  Box,
  Button,
  Chip,
  Link,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { useCopyToClipboard } from "@/components/common/copyable-command";
import { liveCountDecorator } from "@/components/pipeline-graph/pipeline-graph-live-decoration";
import { PipelineGraphView } from "@/components/pipeline-graph/pipeline-graph-view";
import { usePipelineGraphSpec } from "@/components/pipeline-graph/use-pipeline-graph-spec";
import { useProjectPath } from "@/components/project-route-context";
import { runsNavHref } from "@/components/runs/runs-params";
import { PipelineDefinitionArchiveMenu } from "./pipeline-definition-archive-menu";
import type { PipelineLiveCounts } from "./use-pipeline-live-counts";

export const STUDIO_COMMAND = "scarn pipelines studio";
const CARD_GRAPH_HEIGHT = 400;
const NO_NODE_COUNTS: PipelineLiveCounts["nodes"] = {};

function OpenInStudio() {
  const { copied, copy } = useCopyToClipboard();
  return (
    <Tooltip
      title={
        copied
          ? "Copied"
          : `Pipelines are edited in the repo. Run ${STUDIO_COMMAND} there to open the visual designer.`
      }
    >
      <Button
        size="small"
        onClick={() => {
          copy(STUDIO_COMMAND);
        }}
        aria-label={`Open in Studio: copy ${STUDIO_COMMAND}`}
        sx={{ flexShrink: 0 }}
      >
        Open in Studio →
      </Button>
    </Tooltip>
  );
}

/**
 * One pipeline on the Pipelines & Automations page: its name and source
 * file, links to its runs, and its graph decorated with where live runs are.
 * Clicking a node lists the runs at that node.
 */
export function PipelineCard({
  definition,
  counts,
  canManage,
  selected,
  onChanged,
}: {
  definition: PipelineDefinitionContract;
  counts: PipelineLiveCounts | undefined;
  canManage: boolean;
  selected: boolean;
  onChanged: (definition: PipelineDefinitionContract) => void;
}) {
  const router = useRouter();
  const buildPath = useProjectPath();
  const version = definition.currentVersion;
  const { nodes, edges, error } = usePipelineGraphSpec(version);
  const nodeCounts = counts?.nodes ?? NO_NODE_COUNTS;
  const decorateNode = useMemo(
    () => liveCountDecorator(nodeCounts),
    [nodeCounts],
  );
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const runsPath = buildPath("runs");

  return (
    <Box
      component="article"
      aria-label={definition.name}
      sx={{
        border: 1,
        borderColor: selected ? "primary.main" : "divider",
        borderRadius: 2,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      <Box sx={{ p: 2, pb: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography
            sx={{ fontWeight: 600, flex: 1, minWidth: 0 }}
            noWrap
            title={definition.name}
          >
            {definition.name}
          </Typography>
          {definition.archivedAt ? (
            <Chip size="small" variant="outlined" label="Archived" />
          ) : null}
          {version ? (
            <Chip size="small" label={`v${String(version.version)}`} />
          ) : null}
          <OpenInStudio />
          {canManage ? (
            <PipelineDefinitionArchiveMenu
              definition={definition}
              apiClient={apiClient}
              onArchived={onChanged}
              onUnarchived={onChanged}
            />
          ) : null}
        </Stack>
        <Typography
          variant="caption"
          color="text.disabled"
          component="div"
          sx={{ fontFamily: "var(--font-mono)" }}
          title={`Defined in pipelines/${definition.key}.yaml in the repo`}
        >
          pipelines/{definition.key}.yaml
        </Typography>
        <Link
          component={NextLink}
          href={runsNavHref(runsPath, {
            status: "all",
            whatRan: definition.id,
          })}
          variant="body2"
          underline="hover"
          sx={{ display: "inline-block", mt: 0.5 }}
        >
          {counts?.inProgress ?? 0} in progress · {counts?.doneThisWeek ?? 0}{" "}
          done this week →
        </Link>
      </Box>
      <Box
        sx={{
          height: CARD_GRAPH_HEIGHT,
          borderTop: 1,
          borderColor: "divider",
        }}
      >
        {!version ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            No published version. Push a pipeline document from the CLI to
            publish its first version.
          </Typography>
        ) : error ? (
          <Alert severity="error" sx={{ m: 2 }}>
            {error}
          </Alert>
        ) : (
          <PipelineGraphView
            nodes={nodes}
            edges={edges}
            decorateNode={decorateNode}
            onSelectNode={(nodeId) => {
              router.push(
                runsNavHref(runsPath, {
                  status: "all",
                  whatRan: definition.id,
                  at: nodeId,
                }),
              );
            }}
          />
        )}
      </Box>
    </Box>
  );
}
