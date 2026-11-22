"use client";

import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import {
  parseUuidV7,
  stepDefinitionSchema,
} from "@scarn/api/frontend-contracts";
import type {
  PipelineDefinitionContract,
  StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import { unwrapTreatyResponse } from "../../app/_lib/scarn-treaty";
import AddIcon from "@mui/icons-material/Add";
import { Box, Button, Stack, Tab, Tabs } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { AutomationMapPanel } from "../automation-graph/automation-map-panel";
import { PageHeader } from "../page-header";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "../project-route-context";
import { PipelineBuilderModal } from "./pipeline-builder-modal";
import { PipelineCards } from "./pipeline-cards";
import { PipelinesAutomationsSection } from "./pipelines-automations-section";
import { StepLibraryTab } from "./step-library-tab";
import { usePipelineDefinitions } from "./use-pipeline-definitions";
import { useProjectLiveCounts } from "./use-pipeline-live-counts";

const stepDefinitionsArraySchema = z.array(stepDefinitionSchema);

type LibraryTab = "step-library" | "automation-map";

/**
 * The Pipelines & Automations page body: automations (what starts work)
 * with their switches, the pipelines (what runs) as cards with live counts,
 * then the Step Library and the automation map.
 */
export function PipelinePageTabs({
  projectId,
  projectRef,
  selectedPipelineDefinitionId,
}: {
  projectId: string;
  /** The project's `owner/slug` ref, as the CLI commands take it. */
  projectRef: string;
  selectedPipelineDefinitionId?: string | null;
}) {
  const isMember = useIsProjectMember();
  const canEditPipelines = useHasProjectPermission("pipelines:write");
  const canManage = isMember && canEditPipelines;
  const [libraryTab, setLibraryTab] = useState<LibraryTab>("step-library");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [stepDefinitions, setStepDefinitions] = useState<
    StepDefinitionContract[]
  >([]);
  const [createdPipelineId, setCreatedPipelineId] = useState<string | null>(
    null,
  );
  const definitions = usePipelineDefinitions(projectId, showArchived);
  const liveCounts = useProjectLiveCounts(projectId);
  const { upsert } = definitions;

  const loadStepDefinitions = useCallback(async () => {
    try {
      const data = await unwrapTreatyResponse(
        getBrowserScarnApiClient().api["step-definitions"].get({
          query: { projectId: parseUuidV7(projectId) },
        }),
      );
      setStepDefinitions(stepDefinitionsArraySchema.parse(data));
    } catch {
      // non-fatal: pipeline builder will show empty steps list
    }
  }, [projectId]);

  useEffect(() => {
    if (canManage) void loadStepDefinitions();
  }, [canManage, loadStepDefinitions]);

  const handlePipelineCreated = useCallback(
    (pipeline: PipelineDefinitionContract) => {
      upsert(pipeline);
      setCreatedPipelineId(pipeline.id);
      setBuilderOpen(false);
    },
    [upsert],
  );

  const loadedDefinitions =
    definitions.status === "loaded" ? definitions.definitions : null;
  const pipelineNames = useMemo(
    () =>
      new Map(
        (loadedDefinitions ?? []).map((definition) => [
          definition.key,
          definition.name,
        ]),
      ),
    [loadedDefinitions],
  );

  return (
    <>
      <PageHeader
        title="Pipelines & Automations"
        description="Automations decide when a run starts; pipelines are what runs."
        actions={
          canManage ? (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                setBuilderOpen(true);
              }}
            >
              New Pipeline
            </Button>
          ) : null
        }
      />

      <Stack spacing={4}>
        <PipelinesAutomationsSection
          projectId={projectId}
          pipelineNames={pipelineNames}
          inProgress={liveCounts.automations}
        />

        <PipelineCards
          state={definitions}
          counts={liveCounts.pipelines}
          projectRef={projectRef}
          canManage={canManage}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
          selectedPipelineDefinitionId={
            createdPipelineId ?? selectedPipelineDefinitionId ?? null
          }
          onChanged={upsert}
        />

        <Box component="section">
          <Box sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}>
            <Tabs
              value={libraryTab}
              onChange={(_, value: LibraryTab) => {
                setLibraryTab(value);
              }}
              aria-label="Step library and automation map"
            >
              <Tab label="Step Library" value="step-library" />
              <Tab label="Automation map" value="automation-map" />
            </Tabs>
          </Box>
          {libraryTab === "step-library" ? (
            <StepLibraryTab projectId={projectId} canManage={canManage} />
          ) : (
            <AutomationMapPanel projectId={projectId} />
          )}
        </Box>
      </Stack>

      {canManage ? (
        <PipelineBuilderModal
          open={builderOpen}
          projectId={projectId}
          stepDefinitions={stepDefinitions}
          onCreated={handlePipelineCreated}
          onClose={() => {
            setBuilderOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
