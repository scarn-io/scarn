"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Link, Stack, Typography } from "@mui/material";
import type { ManagedConnectionUsageContract } from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { useProjectPath } from "@/components/project-route-context";

type UsageState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; usage: ManagedConnectionUsageContract };

export function ProjectMcpConnectionUsage({
  projectId,
  connectionId,
}: {
  projectId: string;
  connectionId: string;
}) {
  const buildPath = useProjectPath();
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const load = async () => {
      try {
        const { data, error } = await getBrowserScarnApiClient()
          .api.projects({ projectId })
          ["mcp-connections"]({ connectionId: parseUuidV7(connectionId) })
          .usage.get();
        if (cancelled) return;
        setState(!error ? { kind: "loaded", usage: data } : { kind: "failed" });
      } catch {
        if (!cancelled) setState({ kind: "failed" });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, connectionId, attempt]);

  if (state.kind === "loading") {
    return <Typography variant="body2">Loading connection usage…</Typography>;
  }
  if (state.kind === "failed") {
    return (
      <Alert severity="warning">
        Couldn&apos;t load connection usage. The impact is unknown.
        <Button
          size="small"
          onClick={() => {
            setAttempt((value) => value + 1);
          }}
        >
          Retry usage
        </Button>
      </Alert>
    );
  }

  const { usage } = state;
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        Used by {usage.steps.length} steps. {usage.liveRuns} running steps will
        fail and won&apos;t retry.
      </Typography>
      {usage.steps.length > 0 ? (
        <Stack component="ul" spacing={0.5} sx={{ my: 0, pl: 2 }}>
          {usage.steps.map((step) => (
            <Typography component="li" variant="body2" key={step.id}>
              <Link
                href={`${buildPath("pipelines")}?stepDefinitionId=${encodeURIComponent(step.id)}`}
              >
                {step.name} ({step.key})
              </Link>
              {step.pipelines.length > 0
                ? ` — ${step.pipelines.map((pipeline) => pipeline.name).join(", ")}`
                : null}
            </Typography>
          ))}
        </Stack>
      ) : null}
      <Typography variant="caption" color="text.secondary">
        Running counts reflect open connections and may lag until cleanup.
      </Typography>
    </Stack>
  );
}
