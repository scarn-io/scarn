"use client";

import { useState } from "react";
import NextLink from "next/link";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import {
  Alert,
  Button,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
} from "@mui/material";
import { CopyableCommand } from "@/components/common/copyable-command";
import { PipelineEmptyState } from "@/components/pipelines/pipeline-execution-table/empty-state";
import { useProjectPath } from "@/components/project-route-context";
import { AutomationGraphPanel } from "./automation-graph-panel";
import { useProjectAutomations } from "./use-project-automations";

const optionLabel = (automation: AutomationContract): string =>
  [
    automation.title ?? automation.key,
    automation.enabled ? "" : " (disabled)",
    automation.latestVersion ? "" : " (unpublished)",
  ].join("");

/**
 * The Pipelines page's Automations tab: pick one of the project's
 * automations to see the read-only graph of its latest version.
 */
export function AutomationMapPanel({ projectId }: { projectId: string }) {
  const state = useProjectAutomations(projectId);
  const buildPath = useProjectPath();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  if (state.status === "loading") {
    return (
      <PipelineEmptyState
        title="Loading automations"
        description="Fetching the automations for this project."
      />
    );
  }

  if (state.status === "error") {
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={state.reload}>
            Retry
          </Button>
        }
      >
        Couldn&apos;t load automations: {state.message}
      </Alert>
    );
  }

  if (state.automations.length === 0) {
    return (
      <PipelineEmptyState
        title="No automations yet"
        description="This project has no automations. Publish automation documents from the CLI, then manage them in Settings."
        action={
          <Stack spacing={1.5} alignItems="center">
            <CopyableCommand command="scarn pipelines push" />
            <Link component={NextLink} href={buildPath("settings")}>
              Settings → Automations
            </Link>
          </Stack>
        }
      />
    );
  }

  const selected =
    state.automations.find((automation) => automation.key === selectedKey) ??
    null;

  return (
    <Stack spacing={3}>
      <FormControl sx={{ minWidth: 280, maxWidth: 360 }}>
        <InputLabel id="automation-select-label">Automation</InputLabel>
        <Select
          labelId="automation-select-label"
          label="Automation"
          value={selected?.key ?? ""}
          onChange={(event) => {
            setSelectedKey(event.target.value || null);
          }}
        >
          <MenuItem value="">Select an automation</MenuItem>
          {state.automations.map((automation) => (
            <MenuItem key={automation.key} value={automation.key}>
              {optionLabel(automation)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {selected ? (
        <AutomationGraphPanel
          automation={selected}
          pipelineNames={state.pipelineNames}
          stepGrants={state.stepGrants}
        />
      ) : (
        <PipelineEmptyState
          title="No selected automation"
          description="Choose an automation to see its events, rules and routes."
        />
      )}
    </Stack>
  );
}
