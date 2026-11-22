"use client";

import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  AnyJsonObject,
  PipelineDefinitionContract,
  StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { type SyntheticEvent, useCallback, useState } from "react";

type PipelineStep = {
  stepDefinition: StepDefinitionContract;
  name: string;
  key: string;
};

const toKey = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const SUCCEED_NODE_ID = "done";

const uniqueNodeId = (base: string, taken: Set<string>): string => {
  const root = base === "" || base === SUCCEED_NODE_ID ? "step" : base;
  let candidate = root;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${root}_${String(suffix)}`;
  }
  taken.add(candidate);
  return candidate;
};

/**
 * A linear pipeline document: start → each step in order → succeed. Branching,
 * waits and fan-out are authored as JSON in the studio, not here.
 */
export const buildLinearPipelineDocument = (
  key: string,
  title: string,
  steps: readonly PipelineStep[],
): AnyJsonObject => {
  const taken = new Set<string>([SUCCEED_NODE_ID]);
  const nodeIds = steps.map((step) => uniqueNodeId(step.key, taken));
  const nodes: AnyJsonObject = {};
  steps.forEach((step, index) => {
    nodes[nodeIds[index] as string] = {
      kind: "step",
      title: step.name,
      step: step.stepDefinition.key,
      next: {
        routes: [{ to: nodeIds[index + 1] ?? SUCCEED_NODE_ID }],
      },
    };
  });
  nodes[SUCCEED_NODE_ID] = { kind: "succeed" };
  return {
    schemaVersion: 1,
    key,
    title,
    start: { to: nodeIds[0] ?? SUCCEED_NODE_ID },
    nodes,
  };
};

export type PipelineBuilderFormProps = {
  projectId: string;
  stepDefinitions: StepDefinitionContract[];
  onCreated?: (pipeline: PipelineDefinitionContract) => void;
  onCancel?: () => void;
};

export function PipelineBuilderForm({
  projectId,
  stepDefinitions,
  onCreated,
  onCancel,
}: PipelineBuilderFormProps) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [addingStepId, setAddingStepId] = useState<string>("");
  const [error, setError] = useState("");
  const [isPending, setIsPending] = useState(false);

  const addStep = useCallback(() => {
    const def = stepDefinitions.find((s) => s.id === addingStepId);
    if (!def) return;
    const stepName = def.name;
    setSteps((prev) => [
      ...prev,
      { stepDefinition: def, name: stepName, key: toKey(stepName) },
    ]);
    setAddingStepId("");
  }, [addingStepId, stepDefinitions]);

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= steps.length) return;
    setSteps((prev) => {
      const copy = [...prev];
      const tmp = copy[index];
      copy[index] = copy[next] as PipelineStep;
      copy[next] = tmp as PipelineStep;
      return copy;
    });
  };

  const updateStepName = (index: number, value: string) => {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === index ? { ...s, name: value, key: toKey(value) } : s,
      ),
    );
  };

  const handleSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setIsPending(true);

    try {
      const client = getBrowserScarnApiClient();
      const key = toKey(name);
      const { data, error: apiError } = await client.api[
        "pipeline-definitions"
      ].post({
        projectId: parseUuidV7(projectId),
        key,
        name: name.trim(),
        ...(steps.length > 0
          ? { document: buildLinearPipelineDocument(key, name.trim(), steps) }
          : {}),
      });

      if (apiError) {
        throw new Error(
          apiError.value instanceof Error
            ? apiError.value.message
            : "Failed to create pipeline",
        );
      }

      onCreated?.(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create pipeline",
      );
      setIsPending(false);
    }
  };

  const activeStepDefs = stepDefinitions.filter((s) => s.status === "active");

  return (
    <Stack
      spacing={3}
      component="form"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      <Stack spacing={2}>
        <TextField
          label="Pipeline name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          required
          fullWidth
          helperText={name.trim() ? `Key: ${toKey(name)}` : undefined}
        />
      </Stack>

      <div>
        <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
          Steps
        </Typography>

        {steps.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No steps added yet. Add steps below to define the pipeline flow.
            </Typography>
          </Paper>
        ) : (
          <Stack spacing={1.5}>
            {steps.map((step, i) => (
              <Paper
                key={`${step.stepDefinition.id}-${String(i)}`}
                variant="outlined"
                sx={{ p: 1.5 }}
              >
                <Stack direction="row" spacing={1.5} alignItems="flex-start">
                  <Box
                    sx={{
                      minWidth: 28,
                      height: 28,
                      borderRadius: "50%",
                      bgcolor: "primary.main",
                      color: "primary.contrastText",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      flexShrink: 0,
                      mt: 0.5,
                    }}
                  >
                    {i + 1}
                  </Box>
                  <Stack spacing={0.5} flex={1} minWidth={0}>
                    <TextField
                      label="Step name"
                      value={step.name}
                      onChange={(e) => {
                        updateStepName(i, e.target.value);
                      }}
                      size="small"
                      fullWidth
                      helperText={`${step.stepDefinition.name} · key: ${step.key || `step_${String(i + 1)}`}`}
                    />
                  </Stack>
                  <Stack direction="row" spacing={0}>
                    <Tooltip title="Move up">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => {
                            moveStep(i, -1);
                          }}
                          disabled={i === 0}
                        >
                          <ArrowUpwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Move down">
                      <span>
                        <IconButton
                          size="small"
                          onClick={() => {
                            moveStep(i, 1);
                          }}
                          disabled={i === steps.length - 1}
                        >
                          <ArrowDownwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Remove">
                      <IconButton
                        size="small"
                        onClick={() => {
                          removeStep(i);
                        }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
          <FormControl size="small" sx={{ minWidth: 260 }}>
            <InputLabel>Add a step</InputLabel>
            <Select
              label="Add a step"
              value={addingStepId}
              onChange={(e) => {
                setAddingStepId(e.target.value);
              }}
            >
              <MenuItem value="">Select a step definition</MenuItem>
              {activeStepDefs.map((def) => (
                <MenuItem key={def.id} value={def.id}>
                  {def.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={addStep}
            disabled={!addingStepId}
          >
            Add
          </Button>
        </Stack>
      </div>

      {error ? <Alert severity="error">{error}</Alert> : null}

      <Stack direction="row" spacing={1} justifyContent="flex-end">
        {onCancel ? (
          <Button onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="contained"
          disabled={isPending || !name.trim()}
        >
          {isPending ? "Creating…" : "Create Pipeline"}
        </Button>
      </Stack>
    </Stack>
  );
}

export function PipelineBuilderModal({
  open,
  projectId,
  stepDefinitions,
  onCreated,
  onClose,
}: {
  open: boolean;
  projectId: string;
  stepDefinitions: StepDefinitionContract[];
  onCreated?: (pipeline: PipelineDefinitionContract) => void;
  onClose: () => void;
}) {
  const handleCreated = (pipeline: PipelineDefinitionContract) => {
    onCreated?.(pipeline);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New Pipeline</DialogTitle>
      <Divider />
      <DialogContent sx={{ pt: 3 }}>
        <PipelineBuilderForm
          projectId={projectId}
          stepDefinitions={stepDefinitions}
          onCreated={handleCreated}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
