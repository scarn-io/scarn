"use client";

import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
} from "@mui/material";
import { useMemo, useState, useTransition } from "react";
import { ExecutionsList } from "./executions-list";
import type { WorkItemExecutionsData } from "./use-work-item-executions";

/** "New pipeline execution" button; opens a dialog to pick and run a pipeline. */
export function NewExecutionButton({
  projectId,
  workItem,
  data,
}: {
  projectId: string;
  workItem: WorkItemContract;
  data: WorkItemExecutionsData;
}) {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const { definitions, loading, refresh } = data;

  const activeDefinitions = useMemo(
    () =>
      definitions.filter(
        (definition) =>
          definition.archivedAt === null && definition.currentVersion !== null,
      ),
    [definitions],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [isPending, startTransition] = useTransition();

  const openDialog = () => {
    setDialogError("");
    setSelectedDefinitionId(activeDefinitions[0]?.id ?? "");
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (isPending) return;
    setDialogOpen(false);
  };

  const handleCreate = () => {
    if (!selectedDefinitionId) {
      setDialogError("Select a pipeline to run.");
      return;
    }

    startTransition(async () => {
      setDialogError("");
      try {
        await unwrapTreatyResponse(
          apiClient.api["pipeline-executions"].post({
            projectId: parseUuidV7(projectId),
            workItemId: parseUuidV7(workItem.id),
            pipelineDefinitionId: parseUuidV7(selectedDefinitionId),
          }),
        );
        setDialogOpen(false);
        await refresh();
      } catch (createError) {
        setDialogError(
          createError instanceof Error
            ? createError.message
            : "Failed to create pipeline execution",
        );
      }
    });
  };

  return (
    <>
      <Button
        variant="contained"
        size="small"
        onClick={openDialog}
        disabled={loading || activeDefinitions.length === 0}
      >
        New
      </Button>
      <Dialog open={dialogOpen} onClose={closeDialog} maxWidth="sm" fullWidth>
        <DialogTitle>New pipeline execution</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {dialogError ? <Alert severity="error">{dialogError}</Alert> : null}
            <FormControl fullWidth>
              <InputLabel id="new-execution-pipeline-select">
                Pipeline
              </InputLabel>
              <Select
                labelId="new-execution-pipeline-select"
                label="Pipeline"
                value={selectedDefinitionId}
                onChange={(event) => {
                  setSelectedDefinitionId(event.target.value);
                }}
                disabled={isPending}
              >
                {activeDefinitions.map((definition) => (
                  <MenuItem key={definition.id} value={definition.id}>
                    {definition.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={isPending || !selectedDefinitionId}
          >
            {isPending ? "Creating…" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/** The scrollable executions list rendered inside the drawer. */
export function WorkItemExecutionsDrawerBody({
  workItem,
  data,
  onNavigate,
}: {
  workItem: WorkItemContract;
  data: WorkItemExecutionsData;
  /** Called when a row navigates away (used to close the drawer). */
  onNavigate?: () => void;
}) {
  // Already scoped to this work item by the server, newest first.
  const { executions, definitionsById, loading, error } = data;

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 1 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <ExecutionsList
        executions={executions}
        definitionsById={definitionsById}
        from={`work-item:${workItem.id}`}
        onNavigate={onNavigate}
      />
    </Box>
  );
}
