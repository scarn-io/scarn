"use client";

import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";
import {
  parseUuidV7,
  stepDefinitionSchema,
} from "@scarn/api/frontend-contracts";
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import type { ManagedRuntimeId } from "@scarn/sdk/managed-runtimes";
import { unwrapTreatyResponse } from "../../app/_lib/scarn-treaty";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from "@mui/material";
import { type SyntheticEvent, useEffect, useState } from "react";
import {
  emptyObjectSchema,
  editStepEnvironment,
  defaultStepRepoSettings,
  editStepRepo,
  type StepRepoSettings,
  stepRepoSettingsOf,
  parseJsonField,
  toKey,
} from "./step-definition-dialog-helpers";
import { McpServerList } from "./step-definition-dialog-mcp-list";
import { McpToolStepDialog } from "./step-definition-dialog-mcp-tool";
import {
  StepEnvironmentNameField,
  StepManagedRuntimeField,
  StepRuntimeField,
  type StepRuntimeKind,
} from "./step-definition-dialog-environment-fields";
import { StepRepoPolicyFields } from "./step-repo-policy-fields";
import {
  SchemaHelperText,
  SectionHeader,
} from "./step-definition-dialog-sections";

/** Edits a prompt or code step; shows an MCP tool step read-only. */
export function StepDefinitionDialog({
  open,
  projectId,
  step,
  onSaved,
  onClose,
}: {
  open: boolean;
  projectId: string;
  step?: StepDefinitionContract;
  onSaved: (step: StepDefinitionContract) => void;
  onClose: () => void;
}) {
  const isEdit = !!step;

  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1");
  // Typed by the API contract's `kind`, so `code` steps load. Those are
  // authored with the SDK, so there is no `MenuItem` for them below.
  const [kind, setKind] =
    useState<StepDefinitionContract["kind"]>("user_defined");
  const [status, setStatus] = useState<"draft" | "active" | "archived">(
    "draft",
  );
  const [runtimeKind, setRuntimeKind] =
    useState<StepRuntimeKind>("repo-default");
  const [environmentName, setEnvironmentName] = useState("");
  const [resetInline, setResetInline] = useState(false);
  const [managedRuntime, setManagedRuntime] =
    useState<ManagedRuntimeId>("bun1");
  const [runtimeEdited, setRuntimeEdited] = useState(false);
  const [repoSettings, setRepoSettings] = useState<StepRepoSettings>(
    defaultStepRepoSettings,
  );
  const [prompt, setPrompt] = useState("");
  const [inputSchemaJson, setInputSchemaJson] = useState("");
  const [resultSchemaJson, setResultSchemaJson] = useState("");
  const [error, setError] = useState("");
  const [environmentNameError, setEnvironmentNameError] = useState("");
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (step) {
      setName(step.name);
      setKey(step.key);
      setKeyEdited(false);
      setDescription(step.description ?? "");
      setVersion(String(step.version));
      setKind(step.kind);
      setStatus(step.status);
      const runtime =
        step.environment?.kind === "inline"
          ? step.environment.runtime
          : undefined;
      setRuntimeKind(
        step.environment?.kind === "named"
          ? "named"
          : (runtime?.kind ?? "repo-default"),
      );
      setEnvironmentName(
        step.environment?.kind === "named" ? step.environment.name : "",
      );
      setManagedRuntime(runtime?.kind === "managed" ? runtime.id : "bun1");
      setRepoSettings(stepRepoSettingsOf(step.repo));
      setPrompt(step.prompt ?? "");
      setInputSchemaJson(JSON.stringify(step.inputSchemaJson, null, 2));
      setResultSchemaJson(JSON.stringify(step.resultSchemaJson, null, 2));
    } else {
      setName("");
      setKey("");
      setKeyEdited(false);
      setDescription("");
      setVersion("1");
      setKind("user_defined");
      setStatus("draft");
      setRuntimeKind("repo-default");
      setEnvironmentName("");
      setManagedRuntime("bun1");
      setRepoSettings(defaultStepRepoSettings);
      setPrompt("");
      setInputSchemaJson("");
      setResultSchemaJson("");
    }
    setError("");
    setEnvironmentNameError("");
    setRuntimeEdited(false);
    setResetInline(false);
    setIsPending(false);
  }, [open, step]);

  useEffect(() => {
    if (!keyEdited && !isEdit) setKey(toKey(name));
  }, [name, keyEdited, isEdit]);

  const handleClose = () => {
    setError("");
    onClose();
  };

  const handleSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setEnvironmentNameError("");
    setIsPending(true);

    try {
      const parsedVersion = parseInt(version, 10);
      if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
        throw new Error("Version must be a positive integer");
      }

      const inputSchema = inputSchemaJson.trim()
        ? parseJsonField(inputSchemaJson, "Input schema")
        : emptyObjectSchema();
      const resultSchema = resultSchemaJson.trim()
        ? parseJsonField(resultSchemaJson, "Result schema")
        : emptyObjectSchema();
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) {
        throw new Error("Agent prompt is required");
      }

      const environment = editStepEnvironment(step?.environment ?? null, {
        edited: runtimeEdited,
        kind: runtimeKind,
        managedRuntime,
        environmentName,
        resetInline,
      });
      const repo = editStepRepo(step?.repo, repoSettings);
      const body = {
        projectId: parseUuidV7(projectId),
        key: key || toKey(name),
        name: name.trim(),
        description: description.trim() || null,
        prompt: trimmedPrompt,
        version: parsedVersion,
        kind,
        inputSchemaJson: inputSchema,
        resultSchemaJson: resultSchema,
        // MCP servers and health checks are authored in TypeScript and shown
        // read-only here — round-trip whatever was loaded (or null on create)
        // so saving an unrelated field never silently deletes them. See #117.
        opencodeMcpJson: (step?.opencodeMcpJson ?? null) as never,
        healthChecksJson: (step?.healthChecksJson ?? null) as never,
        environment,
        repo,
        status,
        errors: step?.errors ?? [],
      };

      const raw = isEdit
        ? await unwrapTreatyResponse(
            getBrowserScarnApiClient().api["step-definitions"].put(body),
          )
        : await unwrapTreatyResponse(
            getBrowserScarnApiClient().api["step-definitions"].post(body),
          );

      onSaved(stepDefinitionSchema.parse(raw));
      handleClose();
    } catch (err) {
      const message = parseApiError(
        err,
        err instanceof Error ? err.message : "Failed to save step",
      );
      if (
        runtimeKind === "named" &&
        apiErrorCode(err) === "STEP_ENVIRONMENT_NOT_FOUND"
      ) {
        setEnvironmentNameError(message);
      } else {
        setError(message);
      }
      setIsPending(false);
    }
  };

  if (step?.kind === "mcp_tool")
    return <McpToolStepDialog open={open} step={step} onClose={onClose} />;

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {isEdit ? "Edit Step Definition" : "New Step Definition"}
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ pt: 3 }}>
        <Stack
          spacing={2.5}
          component="form"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          <Stack direction="row" spacing={2}>
            <TextField
              label="Name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              required
              sx={{ flex: 2 }}
            />
            <TextField
              label="Key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyEdited(true);
              }}
              disabled={isEdit}
              sx={{ flex: 1 }}
              helperText={
                isEdit
                  ? "Cannot be changed after creation"
                  : "Auto-generated from name; override if needed"
              }
            />
          </Stack>

          <TextField
            label="Description"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            multiline
            minRows={2}
            fullWidth
          />

          <Stack direction="row" spacing={2}>
            <FormControl sx={{ flex: 1 }}>
              <InputLabel>Kind</InputLabel>
              <Select
                label="Kind"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                }}
              >
                <MenuItem value="user_defined">Custom (user_defined)</MenuItem>
                <MenuItem value="built_in">Built-in</MenuItem>
              </Select>
            </FormControl>
            <FormControl sx={{ flex: 1 }}>
              <InputLabel>Status</InputLabel>
              <Select
                label="Status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                }}
              >
                <MenuItem value="draft">Draft</MenuItem>
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="archived">Archived</MenuItem>
              </Select>
            </FormControl>
            <TextField
              label="Version"
              type="number"
              value={version}
              onChange={(e) => {
                setVersion(e.target.value);
              }}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
              sx={{ flex: 1 }}
            />
          </Stack>

          <StepRuntimeField
            kind={runtimeKind}
            isCode={kind === "code"}
            onChange={(kind) => {
              setRuntimeKind(kind);
              setRuntimeEdited(true);
              if (kind === "named") setResetInline(true);
            }}
          />
          {runtimeKind === "managed" ? (
            <StepManagedRuntimeField
              runtime={managedRuntime}
              onChange={(runtime) => {
                setManagedRuntime(runtime);
                setRuntimeEdited(true);
              }}
            />
          ) : null}
          {runtimeKind === "named" ? (
            <StepEnvironmentNameField
              name={environmentName}
              error={environmentNameError || undefined}
              onChange={(name) => {
                setEnvironmentName(name);
                setEnvironmentNameError("");
                setRuntimeEdited(true);
              }}
            />
          ) : null}
          <StepRepoPolicyFields
            settings={repoSettings}
            onChange={setRepoSettings}
          />

          <SectionHeader>Agent Configuration</SectionHeader>

          <TextField
            label="Agent prompt"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
            }}
            multiline
            minRows={6}
            fullWidth
            required
            helperText="Instructions for the AI agent."
          />

          <SectionHeader>Schemas</SectionHeader>

          <TextField
            label="Input Schema (JSON)"
            value={inputSchemaJson}
            onChange={(e) => {
              setInputSchemaJson(e.target.value);
            }}
            multiline
            minRows={4}
            fullWidth
            placeholder='{"type": "object", "properties": {}}'
            helperText={<SchemaHelperText />}
          />

          <TextField
            label="Result Schema (JSON)"
            value={resultSchemaJson}
            onChange={(e) => {
              setResultSchemaJson(e.target.value);
            }}
            multiline
            minRows={4}
            fullWidth
            placeholder='{"type": "object", "properties": {}}'
            helperText={<SchemaHelperText />}
          />

          <SectionHeader>MCP Servers</SectionHeader>

          <McpServerList
            projectId={projectId}
            servers={step?.opencodeMcpJson ?? null}
            healthChecks={step?.healthChecksJson ?? null}
          />

          {error ? <Alert severity="error">{error}</Alert> : null}

          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button onClick={handleClose} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={isPending || !name.trim()}
            >
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Step"}
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
