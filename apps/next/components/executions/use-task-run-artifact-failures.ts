"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import { artifactFailureSchema, parseUuidV7 } from "@scarn/api/frontend-contracts";
import { z } from "zod";
import type { ArtifactFailureContract } from "@scarn/api/frontend-contracts";

/** Lifecycle of the lazily-loaded artifact-failure list. */
export type ArtifactFailuresStatus = "idle" | "loading" | "loaded" | "error";

export type TaskRunArtifactFailuresData = {
  /** The task's persisted artifact upload failures, once loaded. */
  artifactFailures: ArtifactFailureContract[];
  /** Coarse lifecycle state for driving idle/loading/loaded/error UI. */
  status: ArtifactFailuresStatus;
  /** True while the list request is in flight (equivalent to status === "loading"). */
  loading: boolean;
  /** Load/list error message, or "" when there is none. */
  error: string;
  /**
   * Lazily fetches the artifact-failure list. Safe to call repeatedly; a call
   * while a fetch is already in flight is ignored. Intended to be triggered
   * when the user expands the Artifacts section (not on mount).
   */
  load: () => void;
};

/**
 * Owns lazy artifact-failure listing for a single task. Kept
 * separate from {@link useTaskRunArtifacts} — that hook's contract is
 * deliberately narrow (one list + one download action); mixing in a second
 * independent GET/loading/error state would muddy it. Unlike
 * {@link useTaskRunLogs}, this does NOT fetch on mount: the consumer
 * calls {@link TaskRunArtifactFailuresData.load} when the Artifacts
 * section is expanded, keeping read-side cost off the hot path.
 *
 * Responses are re-validated against the frontend contract
 * (`artifactFailureSchema`) so a drifting server payload fails loudly rather
 * than propagating an ill-typed value into the UI.
 */
export function useTaskRunArtifactFailures(
  taskRunId: string | null,
): TaskRunArtifactFailuresData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [artifactFailures, setArtifactFailures] = useState<
    ArtifactFailureContract[]
  >([]);
  const [status, setStatus] = useState<ArtifactFailuresStatus>("idle");
  const [error, setError] = useState("");
  // Guards against overlapping list fetches (e.g. rapid expand/collapse).
  const loadingRef = useRef(false);

  const load = useCallback(() => {
    if (!taskRunId || loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setStatus("loading");
    setError("");

    void (async () => {
      try {
        const id = parseUuidV7(taskRunId);
        const result = await unwrapTreatyResponse(
          apiClient.api["task-runs"]({ taskRunId: id })[
            "artifact-failures"
          ].get(),
        );
        const parsed = z.array(artifactFailureSchema).safeParse(result);
        if (!parsed.success) {
          setStatus("error");
          setError("Received invalid artifact failures payload");
          return;
        }
        setArtifactFailures(parsed.data);
        setStatus("loaded");
      } catch (loadError) {
        setStatus("error");
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load artifact failures",
        );
      } finally {
        loadingRef.current = false;
      }
    })();
  }, [apiClient, taskRunId]);

  return {
    artifactFailures,
    status,
    loading: status === "loading",
    error,
    load,
  };
}
