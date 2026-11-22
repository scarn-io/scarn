"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Stack,
  Typography,
} from "@mui/material";
import type { ManagedConnectionToolsContract } from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorStatus } from "@/app/_lib/api-error";

const MAX_RETRY_AFTER_MS = 3_000;

type ToolsState =
  | { kind: "loading" }
  | { kind: "loaded"; tools: ManagedConnectionToolsContract["tools"] }
  | { kind: "failed" };

type ToolsResult = {
  data: ManagedConnectionToolsContract | null;
  error: unknown;
  response?: Response | null;
};

const retryAfterMs = (response: Response | null | undefined) => {
  const header = response?.headers.get("Retry-After");
  const seconds = header ? Number(header) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const toolCountLine = (count: number) =>
  `Working — ${String(count)} ${count === 1 ? "tool" : "tools"} available`;

function ToolList({
  tools,
}: {
  tools: ManagedConnectionToolsContract["tools"];
}) {
  return (
    <Stack component="ul" spacing={1} sx={{ listStyle: "none", m: 0, p: 0 }}>
      {tools.map((tool) => (
        <Stack component="li" key={tool.name} spacing={0.25}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" fontFamily="monospace">
              {tool.name}
            </Typography>
            {tool.readOnlyHint ? (
              <Chip size="small" variant="outlined" label="Read-only" />
            ) : null}
            {tool.outputSchema ? (
              <Chip size="small" variant="outlined" label="Structured output" />
            ) : null}
          </Stack>
          {tool.description ? (
            <Typography variant="body2" color="text.secondary">
              {tool.description}
            </Typography>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The tools a serving connection offers, listed server-side. Shown only to
 * members who can run steps (`executions:write`). Never shows anything the
 * provider sent besides the tool listing itself. A 409 means the connection
 * changed state server-side, so `onNotReady` lets the panel reload it.
 */
export function ProjectMcpConnectionTools({
  projectId,
  connectionId,
  label,
  onNotReady,
}: {
  projectId: string;
  connectionId: string;
  label: string;
  onNotReady: () => void;
}) {
  const [state, setState] = useState<ToolsState>({ kind: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const fetchTools = useCallback(
    (): Promise<ToolsResult> =>
      getBrowserScarnApiClient()
        .api.projects({ projectId })
        ["mcp-connections"]({ connectionId: parseUuidV7(connectionId) })
        .tools.get(),
    [projectId, connectionId],
  );

  useEffect(() => {
    const run = { cancelled: false };
    const load = async () => {
      let result = await fetchTools();
      if (result.error && apiErrorStatus(result.error) === 503) {
        await wait(retryAfterMs(result.response));
        if (run.cancelled) return;
        result = await fetchTools();
      }
      if (run.cancelled) return;
      if (result.data) {
        setState({ kind: "loaded", tools: result.data.tools });
        return;
      }
      if (apiErrorStatus(result.error) === 409) {
        onNotReady();
      }
      setState({ kind: "failed" });
    };
    setState({ kind: "loading" });
    load().catch(() => {
      if (!run.cancelled) setState({ kind: "failed" });
    });
    return () => {
      run.cancelled = true;
    };
  }, [fetchTools, attempt, onNotReady]);

  if (state.kind === "loading") {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={14} aria-label="Loading tools" />
        <Typography variant="body2" color="text.secondary">
          Listing tools…
        </Typography>
      </Stack>
    );
  }

  if (state.kind === "failed") {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t reach {label} to list tools. Try again.
        </Typography>
        <Button
          size="small"
          onClick={() => {
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2">
          {toolCountLine(state.tools.length)}
        </Typography>
        {state.tools.length > 0 ? (
          <Button
            size="small"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((open) => !open);
            }}
          >
            {expanded ? "Hide tools" : "Show tools"}
          </Button>
        ) : null}
      </Stack>
      <Collapse in={expanded} unmountOnExit>
        <ToolList tools={state.tools} />
      </Collapse>
    </Stack>
  );
}
