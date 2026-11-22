"use client";

/**
 * Starts a Task on a work item, from the latest version of a step definition
 * or from a free-form prompt, then opens the new Task's view.
 */

import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormHelperText,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import { fetchProjectStepDefinitions } from "@/app/(protected)/projects/_lib/project-work-items";
import {
  useHasProjectPermission,
  useProjectPath,
} from "@/components/project-route-context";
import type { TaskEnvironmentInput } from "@scarn/core/tasks/task/contracts/task-environment-selection-contracts";
import {
  StartTaskConnectorsField,
  StartTaskConnectorVarFields,
} from "./start-task-connector-fields";
import {
  activeExtras,
  buildEnvironmentInput,
  effectiveEnvironmentFacts,
  effectiveEnvironmentName,
  environmentDefaultLabel,
  isEnvironmentLocked,
  lockedConnectors,
  mapStartTaskError,
  type ExtraVarDrafts,
  type StartTaskErrors,
  type StartTaskMode,
} from "./start-task-environment";
import { StartTaskAddSecretDialog } from "./start-task-add-secret-dialog";
import { StartTaskEnvironmentField } from "./start-task-environment-fields";
import { startTask, type StartTaskInput } from "./task-api";
import {
  useConnectorCatalog,
  useEnvironmentFacts,
  useProjectEnvironments,
  useProjectSecretNames,
} from "./use-project-environments";

/** One entry per step definition, at its highest version. */
export function latestStepDefinitions<
  T extends { id: string; name: string; version: number },
>(definitions: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const definition of definitions) {
    const current = byId.get(definition.id);
    if (!current || definition.version > current.version) {
      byId.set(definition.id, definition);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The `POST /api/tasks` body for the dialog's choice; `null` when incomplete. */
export function buildStartTaskInput({
  projectId,
  workItemId,
  mode,
  stepDefinition,
  prompt,
  repoWrite = false,
  environment,
}: {
  projectId: string;
  workItemId: string;
  mode: StartTaskMode;
  stepDefinition: { id: string; version: number } | null;
  prompt: string;
  /** "Allow commits", for a prompt Task only. */
  repoWrite?: boolean;
  environment?: TaskEnvironmentInput | null;
}): StartTaskInput | null {
  if (environment === null) return null;
  const chosen = environment ? { environment } : {};
  if (mode === "step") {
    if (!stepDefinition) return null;
    return {
      projectId,
      workItemId,
      stepDefinitionId: stepDefinition.id,
      stepDefinitionVersion: stepDefinition.version,
      ...chosen,
    };
  }
  const trimmed = prompt.trim();
  return trimmed
    ? { projectId, workItemId, prompt: trimmed, repoWrite, ...chosen }
    : null;
}

export function StartTaskButton({
  projectId,
  workItemId,
}: {
  projectId: string;
  workItemId: string;
}) {
  const canStart = useHasProjectPermission("executions:write");
  const [open, setOpen] = useState(false);
  if (!canStart) return null;
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        onClick={() => {
          setOpen(true);
        }}
      >
        Start task
      </Button>
      {open ? (
        <StartTaskDialog
          projectId={projectId}
          workItemId={workItemId}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function StartTaskDialog({
  projectId,
  workItemId,
  onClose,
}: {
  projectId: string;
  workItemId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const projectPath = useProjectPath();
  const [mode, setMode] = useState<StartTaskMode>("step");
  const [definitions, setDefinitions] = useState<StepDefinitionContract[]>([]);
  const [stepDefinitionId, setStepDefinitionId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repoWrite, setRepoWrite] = useState(false);
  const [override, setOverride] = useState("");
  const [extras, setExtras] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<ExtraVarDrafts>({});
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<StartTaskErrors>({});
  const environments = useProjectEnvironments(projectId);
  const catalog = useConnectorCatalog();
  const loadedSecretNames = useProjectSecretNames(projectId);
  const [addedSecretNames, setAddedSecretNames] = useState<string[]>([]);
  const savedSecretNames = useMemo(
    () => [...new Set([...loadedSecretNames, ...addedSecretNames])],
    [loadedSecretNames, addedSecretNames],
  );
  const canAddSecrets = useHasProjectPermission("secrets:write");
  const [addingSecret, setAddingSecret] = useState<{
    connectorId: string;
    varName: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectStepDefinitions(projectId).then((loaded) => {
      if (!cancelled) setDefinitions(latestStepDefinitions(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const selected = useMemo(
    () => definitions.find((d) => d.id === stepDefinitionId) ?? null,
    [definitions, stepDefinitionId],
  );
  const step = mode === "step" ? selected : null;
  const environmentLocked = isEnvironmentLocked(mode, step);
  const chosenOverride = environmentLocked ? "" : override;
  const namedFacts = useEnvironmentFacts(
    projectId,
    effectiveEnvironmentName(mode, step, chosenOverride),
  );
  const environment = effectiveEnvironmentFacts(
    mode,
    step,
    chosenOverride,
    namedFacts,
  );
  const locked = lockedConnectors({
    mode,
    step,
    override: chosenOverride,
    environment,
  });
  const chosenExtras = activeExtras(extras, locked);
  const input = buildStartTaskInput({
    projectId,
    workItemId,
    mode,
    stepDefinition: selected,
    prompt,
    repoWrite,
    environment: buildEnvironmentInput({
      override: chosenOverride,
      extras: chosenExtras,
      catalog,
      environment,
      drafts,
      savedSecretNames,
    }),
  });
  const canSubmit = !submitting && input !== null;

  const submit = async () => {
    if (!input) return;
    setSubmitting(true);
    setErrors({});
    try {
      const created = await startTask(input);
      router.push(projectPath("runs", "tasks", created.task.id));
    } catch (thrown) {
      setErrors(mapStartTaskError(thrown));
      setSubmitting(false);
    }
  };

  const clearError = (field: keyof StartTaskErrors) => {
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const changeVar = (connectorId: string, varName: string, secret: string) => {
    setDrafts((current) => ({
      ...current,
      [connectorId]: { ...current[connectorId], [varName]: secret },
    }));
    clearError("vars");
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Start a task</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            onChange={(_event, next: StartTaskMode | null) => {
              if (next) setMode(next);
            }}
          >
            <ToggleButton value="step">Step definition</ToggleButton>
            <ToggleButton value="prompt">Prompt</ToggleButton>
          </ToggleButtonGroup>
          {mode === "step" ? (
            <TextField
              select
              label="Step definition"
              value={stepDefinitionId}
              onChange={(event) => {
                setStepDefinitionId(event.target.value);
              }}
              helperText="Runs the latest version."
            >
              {definitions.map((definition) => (
                <MenuItem key={definition.id} value={definition.id}>
                  {definition.name} ({definition.key} v
                  {String(definition.version)})
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <>
              <TextField
                label="Prompt"
                multiline
                minRows={4}
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                }}
              />
              <div>
                <FormControlLabel
                  control={
                    <Switch
                      checked={repoWrite}
                      onChange={(event) => {
                        setRepoWrite(event.target.checked);
                      }}
                    />
                  }
                  label="Allow commits"
                />
                <FormHelperText>
                  The agent can push a new <code>scarn/…</code> branch.
                </FormHelperText>
              </div>
            </>
          )}
          <StartTaskEnvironmentField
            defaultLabel={environmentDefaultLabel(mode)}
            environments={environments}
            value={override}
            locked={environmentLocked}
            error={errors.environment}
            onChange={(name) => {
              setOverride(name);
              clearError("environment");
            }}
          />
          <StartTaskConnectorsField
            catalog={catalog}
            locked={locked}
            extras={chosenExtras}
            error={errors.connectors}
            onChange={(next) => {
              setExtras(next);
              clearError("connectors");
            }}
          />
          <StartTaskConnectorVarFields
            catalog={catalog}
            extras={chosenExtras}
            environment={environment}
            drafts={drafts}
            savedSecretNames={savedSecretNames}
            errors={errors.vars}
            onChange={changeVar}
            onAddSecret={
              canAddSecrets
                ? (connectorId, varName, name) => {
                    setAddingSecret({ connectorId, varName, name });
                  }
                : undefined
            }
          />
          {addingSecret ? (
            <StartTaskAddSecretDialog
              projectId={projectId}
              initialName={addingSecret.name}
              onClose={() => {
                setAddingSecret(null);
              }}
              onSaved={(name) => {
                setAddedSecretNames((current) => [...current, name]);
                changeVar(addingSecret.connectorId, addingSecret.varName, name);
                setAddingSecret(null);
              }}
            />
          ) : null}
          {errors.general ? (
            <Alert severity="error">{errors.general}</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!canSubmit}
          onClick={() => {
            void submit();
          }}
        >
          Start
        </Button>
      </DialogActions>
    </Dialog>
  );
}
