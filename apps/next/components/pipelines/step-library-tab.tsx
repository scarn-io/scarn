"use client";

import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import {
  parseUuidV7,
  stepDefinitionSchema,
} from "@scarn/api/frontend-contracts";
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import { unwrapTreatyResponse } from "../../app/_lib/scarn-treaty";
import AddIcon from "@mui/icons-material/Add";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { PipelineEmptyState } from "./pipeline-execution-table/empty-state";
import { StepDefinitionDialog } from "./step-definition-dialog";

const stepDefinitionsArraySchema = z.array(stepDefinitionSchema);

type StepKind = StepDefinitionContract["kind"];
type StepKindFilter = "all" | StepKind;

const KIND_LABEL: Record<StepKind, string> = {
  built_in: "Built-in",
  user_defined: "Custom",
  code: "Code",
  mcp_tool: "MCP tool",
};

const KIND_FILTER_NOUN: Record<StepKind, string> = {
  built_in: "built-in",
  user_defined: "custom",
  code: "code",
  mcp_tool: "MCP tool",
};

function isStepKindFilter(value: string): value is StepKindFilter {
  return value === "all" || value in KIND_LABEL;
}

const STATUS_COLOR: Record<
  string,
  "default" | "success" | "warning" | "error"
> = {
  active: "success",
  draft: "warning",
  archived: "default",
};

function StepCard({
  step,
  onClick,
}: {
  step: StepDefinitionContract;
  onClick: () => void;
}) {
  return (
    <Paper
      component={ButtonBase}
      variant="outlined"
      onClick={onClick}
      sx={{ p: 2, display: "block", width: "100%", textAlign: "left" }}
    >
      <Stack spacing={0.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            {step.name}
          </Typography>
          <Chip
            label={KIND_LABEL[step.kind]}
            size="small"
            variant="outlined"
            color={step.kind === "built_in" ? "primary" : "default"}
          />
          {step.toolCallJson ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: "monospace" }}
            >
              {step.toolCallJson.server}.{step.toolCallJson.tool}
            </Typography>
          ) : null}
          <Chip
            label={step.status}
            size="small"
            color={STATUS_COLOR[step.status] ?? "default"}
          />
          {step.environment?.kind === "inline" &&
          step.environment.runtime?.kind === "host" ? (
            <Chip label="Host" size="small" variant="outlined" />
          ) : null}
        </Stack>
        {step.description ? (
          <Typography variant="body2" color="text.secondary">
            {step.description}
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.disabled">
          Key: {step.key} · v{step.version}
        </Typography>
      </Stack>
    </Paper>
  );
}

export function StepLibraryTab({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const searchParams = useSearchParams();
  const requestedStepId = searchParams.get("stepDefinitionId");
  const [dismissedStepId, setDismissedStepId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepDefinitionContract[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [loadError, setLoadError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<StepDefinitionContract | null>(
    null,
  );
  const [filter, setFilter] = useState<StepKindFilter>("all");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadState("loading");
      try {
        const data = await unwrapTreatyResponse(
          getBrowserScarnApiClient().api["step-definitions"].get({
            query: { projectId: parseUuidV7(projectId) },
          }),
        );
        if (cancelled) return;
        setSteps(stepDefinitionsArraySchema.parse(data));
        setLoadState("loaded");
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load steps",
        );
        setLoadState("error");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const filtered = useMemo(
    () => (filter === "all" ? steps : steps.filter((s) => s.kind === filter)),
    [steps, filter],
  );

  const openCreate = () => {
    setEditingStep(null);
    setDialogOpen(true);
  };

  const openEdit = (step: StepDefinitionContract) => {
    setEditingStep(step);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDismissedStepId(requestedStepId);
    setDialogOpen(false);
    setEditingStep(null);
  };

  const linkedStep =
    loadState === "loaded" && requestedStepId !== dismissedStepId
      ? steps.find((step) => step.id === requestedStepId)
      : undefined;

  const handleSaved = (saved: StepDefinitionContract) => {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === saved.id);
      return idx >= 0
        ? prev.map((s) => (s.id === saved.id ? saved : s))
        : [...prev, saved];
    });
    closeDialog();
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Filter</InputLabel>
          <Select
            label="Filter"
            value={filter}
            onChange={(e) => {
              if (isStepKindFilter(e.target.value)) setFilter(e.target.value);
            }}
          >
            <MenuItem value="all">All steps</MenuItem>
            <MenuItem value="built_in">Built-in</MenuItem>
            <MenuItem value="user_defined">Custom</MenuItem>
            <MenuItem value="code">Code</MenuItem>
            <MenuItem value="mcp_tool">MCP tool</MenuItem>
          </Select>
        </FormControl>
        <Box sx={{ flex: 1 }} />
        {canManage ? (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={openCreate}
          >
            New Step
          </Button>
        ) : null}
      </Stack>

      {loadState === "error" ? (
        <Alert severity="error">{loadError}</Alert>
      ) : null}
      {loadState === "loaded" &&
      requestedStepId &&
      requestedStepId !== dismissedStepId &&
      !linkedStep ? (
        <Alert severity="warning">
          The linked step is no longer available.
        </Alert>
      ) : null}

      {loadState === "loading" ? (
        <PipelineEmptyState
          title="Loading step definitions"
          description="Fetching the step definitions for this project."
        />
      ) : null}

      {loadState === "loaded" && filtered.length === 0 ? (
        <PipelineEmptyState
          title="No step definitions"
          description={
            filter === "all"
              ? "No step definitions found for this project."
              : `No ${KIND_FILTER_NOUN[filter]} step definitions found.`
          }
        />
      ) : null}

      {loadState === "loaded" && filtered.length > 0 ? (
        <Stack spacing={1.5}>
          {filtered.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              onClick={() => {
                openEdit(step);
              }}
            />
          ))}
        </Stack>
      ) : null}

      <StepDefinitionDialog
        open={dialogOpen || Boolean(linkedStep)}
        projectId={projectId}
        {...(editingStep || linkedStep
          ? { step: editingStep ?? linkedStep }
          : {})}
        onSaved={handleSaved}
        onClose={closeDialog}
      />
    </Stack>
  );
}
