"use client";

import type { PipelineDefinitionContract } from "@scarn/api/frontend-contracts";
import {
  Alert,
  Box,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { PipelineEmptyState } from "./pipeline-execution-table/empty-state";
import { PipelineCard } from "./pipeline-card";
import { PipelineGettingStarted } from "./pipeline-getting-started";
import type { PipelineDefinitionsState } from "./use-pipeline-definitions";
import type { PipelineLiveCounts } from "./use-pipeline-live-counts";

/**
 * The Pipelines section: a two-column grid of pipeline cards with live
 * counts, a "Show archived" switch, and the getting-started steps when the
 * project has no pipelines yet.
 */
export function PipelineCards({
  state,
  counts,
  projectRef,
  canManage,
  showArchived,
  onShowArchivedChange,
  selectedPipelineDefinitionId,
  onChanged,
}: {
  state: PipelineDefinitionsState;
  counts: ReadonlyMap<string, PipelineLiveCounts>;
  projectRef: string;
  canManage: boolean;
  showArchived: boolean;
  onShowArchivedChange: (showArchived: boolean) => void;
  selectedPipelineDefinitionId: string | null;
  onChanged: (definition: PipelineDefinitionContract) => void;
}) {
  return (
    <Stack component="section" spacing={1} aria-label="Pipelines">
      <Stack direction="row" alignItems="center" spacing={2}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Pipelines
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Where every live run is right now. A run can be at several nodes at
            once (lanes). Click a node to list the runs there.
          </Typography>
        </Box>
        <FormControlLabel
          sx={{ flexShrink: 0, mr: 0 }}
          control={
            <Switch
              size="small"
              checked={showArchived}
              onChange={(event) => {
                onShowArchivedChange(event.target.checked);
              }}
            />
          }
          label="Show archived"
        />
      </Stack>

      {state.status === "error" ? (
        <Alert severity="error">{state.message}</Alert>
      ) : null}

      {state.status === "loading" ? (
        <PipelineEmptyState
          title="Loading pipeline definitions"
          description="Fetching the pipeline definitions available for this project."
        />
      ) : null}

      {state.status === "loaded" && state.definitions.length === 0 ? (
        <PipelineEmptyState
          title="No pipelines yet"
          description="Design your first pipeline from your repo with the CLI. Running scarn init links the repo to this project and opens the pipeline designer, which pushes the pipeline and offers to run it."
          action={<PipelineGettingStarted projectRef={projectRef} />}
        />
      ) : null}

      {state.status === "loaded" && state.definitions.length > 0 ? (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
            gap: 2,
          }}
        >
          {state.definitions.map((definition) => (
            <PipelineCard
              key={definition.id}
              definition={definition}
              counts={counts.get(definition.id)}
              canManage={canManage}
              selected={definition.id === selectedPipelineDefinitionId}
              onChanged={onChanged}
            />
          ))}
        </Box>
      ) : null}
    </Stack>
  );
}
