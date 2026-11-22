"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import type { AutomationContract } from "@scarn/api/frontend-contracts";
import { Alert, Box, Link, Stack, Switch, Typography } from "@mui/material";
import { fetchProjectAutomations } from "@/app/(protected)/projects/_lib/project-work-items";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { CopyableCommand } from "@/components/common/copyable-command";
import {
  useHasProjectPermission,
  useIsProjectMember,
  useProjectPath,
} from "@/components/project-route-context";
import { runsNavHref } from "@/components/runs/runs-params";
import { automationStarts } from "./automation-targets";

const SCOPE_TAGS: Record<AutomationContract["scope"], string> = {
  project: "whole project",
  workItem: "one work item",
};

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; automations: AutomationContract[] };

const byKey = (left: AutomationContract, right: AutomationContract) =>
  left.key.localeCompare(right.key);

function ScopeTag({ scope }: { scope: AutomationContract["scope"] }) {
  return (
    <Box
      component="span"
      sx={{
        ml: 1,
        px: 0.75,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        fontSize: 11,
        fontWeight: 400,
        color: "text.secondary",
        verticalAlign: "middle",
      }}
    >
      {SCOPE_TAGS[scope]}
    </Box>
  );
}

function AutomationRow({
  automation,
  starts,
  inProgress,
  showSwitch,
  canToggle,
  pending,
  onToggle,
  isFirst,
}: {
  automation: AutomationContract;
  starts: string[];
  inProgress: number;
  showSwitch: boolean;
  canToggle: boolean;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  isFirst: boolean;
}) {
  const buildPath = useProjectPath();
  const name = automation.title ?? automation.key;
  const isProject = automation.scope === "project";
  const dimmed = isProject && !automation.enabled;
  const version = automation.latestVersion
    ? `v${String(automation.latestVersion.version)}`
    : "not published";

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={2}
      sx={{
        px: 2,
        py: 1.5,
        borderTop: isFirst ? 0 : 1,
        borderColor: "divider",
      }}
    >
      <Box sx={{ width: 40, flexShrink: 0 }}>
        {isProject && showSwitch ? (
          <Switch
            size="small"
            checked={automation.enabled}
            disabled={!canToggle || pending}
            onChange={(event) => {
              onToggle(event.target.checked);
            }}
            slotProps={{ input: { "aria-label": `Enable ${name}` } }}
          />
        ) : null}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, opacity: dimmed ? 0.6 : 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {name}
          <ScopeTag scope={automation.scope} />
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div">
          {automation.key} · {version}
          {isProject ? "" : " · attached from a work item's page"}
        </Typography>
        {starts.length > 0 ? (
          <Typography
            variant="caption"
            color="text.disabled"
            component="div"
            noWrap
          >
            Starts {starts.join(" · ")}
          </Typography>
        ) : null}
      </Box>
      <Link
        component={NextLink}
        href={runsNavHref(buildPath("runs"), {
          status: "open",
          by: automation.id,
        })}
        variant="body2"
        underline="hover"
        sx={{ flexShrink: 0 }}
      >
        {inProgress} in progress →
      </Link>
    </Stack>
  );
}

/**
 * The Automations section: one row per automation with its on/off switch
 * (project automations; members see it, those with `executions:write`
 * can flip it), scope tag, what
 * it starts and a link to the runs it has in progress. This is the only
 * place the switch lives.
 */
export function PipelinesAutomationsSection({
  projectId,
  pipelineNames,
  inProgress,
}: {
  projectId: string;
  /** Pipeline key → name, for "Starts …". */
  pipelineNames: ReadonlyMap<string, string>;
  /** In-progress runs by automation id; absent means none. */
  inProgress: ReadonlyMap<string, number>;
}) {
  const isMember = useIsProjectMember();
  const canToggle = useHasProjectPermission("pipelines:write");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProjectAutomations(projectId)
      .then((automations) => {
        if (!cancelled) {
          setState({
            status: "ready",
            automations: [...automations].sort(byKey),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const setEnabled = async (key: string, enabled: boolean) => {
    setError(null);
    setPendingKey(key);
    const automation = getBrowserScarnApiClient()
      .api.projects({ projectId })
      .automations({ key });
    const { data, error: apiError } = enabled
      ? await automation.enable.post()
      : await automation.disable.post();
    setPendingKey(null);
    if (apiError) {
      setError(
        parseApiError(apiError, "Could not change the automation. Try again."),
      );
      return;
    }
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            automations: current.automations.map((entry) =>
              entry.key === data.key ? data : entry,
            ),
          }
        : current,
    );
  };

  return (
    <Stack component="section" spacing={1} aria-label="Automations">
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Automations
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {state.status === "loading" ? (
        <Typography variant="body2" color="text.secondary">
          Loading automations…
        </Typography>
      ) : null}
      {state.status === "error" ? (
        <Alert severity="error">Couldn&apos;t load automations.</Alert>
      ) : null}
      {state.status === "ready" && state.automations.length === 0 ? (
        <Stack spacing={1} alignItems="flex-start">
          <Typography variant="body2" color="text.secondary">
            No automations yet. Push an automation document from the CLI to
            start runs on its own.
          </Typography>
          <CopyableCommand command="scarn pipelines push" />
        </Stack>
      ) : null}
      {state.status === "ready" && state.automations.length > 0 ? (
        <Box
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          {state.automations.map((automation, index) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              starts={automationStarts(automation, pipelineNames)}
              inProgress={inProgress.get(automation.id) ?? 0}
              showSwitch={isMember}
              canToggle={canToggle}
              pending={pendingKey !== null}
              onToggle={(enabled) => {
                void setEnabled(automation.key, enabled);
              }}
              isFirst={index === 0}
            />
          ))}
        </Box>
      ) : null}
    </Stack>
  );
}
