"use client";

import { useEffect, useMemo, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import { taskRunSchema, parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { TaskRunContract } from "@scarn/api/frontend-contracts";

/**
 * Fetches the FULL `TaskRunContract` (input, result, lease/log-archive
 * fields — everything `taskSnapshot` deliberately leaves out) for
 * whichever single step is currently open in the detail panel, on demand.
 *
 * This is the on-demand counterpart to the pipeline execution's embedded
 * `taskSnapshot`: the execution-detail poll already refreshes every
 * step run's lean status/timing every tick, so this hook only needs to fetch
 * when a) the selected step changes, or b) that step's embedded snapshot
 * reports it changed since the last fetch (`updatedAt` advanced — e.g. a
 * heartbeat, or it just completed). That keeps this to at most one
 * `GET /task-runs/:taskRunId` per real change on the ONE step being viewed,
 * instead of the old design's poll of every active step on every tick.
 */
export function useSelectedTaskRun(
  taskRunId: string | null,
  snapshotUpdatedAt: string | null,
): {
  taskRun: TaskRunContract | null;
  loading: boolean;
  error: string;
} {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [taskRun, setTaskRun] = useState<TaskRunContract | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!taskRunId) {
      setTaskRun(null);
      setError("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const load = async () => {
      try {
        const data = await unwrapTreatyResponse(
          apiClient.api["task-runs"]({
            taskRunId: parseUuidV7(taskRunId),
          }).get(),
        );
        if (controller.signal.aborted) return;
        const parsed = taskRunSchema.safeParse(data);
        if (parsed.success) {
          setTaskRun(parsed.data);
          setError("");
        } else {
          setError("Received invalid task payload");
        }
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load task",
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
    };
    // Re-fetch when the selected step changes, or when the pipeline
    // execution poll reports this step's snapshot advanced — not on every
    // poll tick (`snapshotUpdatedAt` is stable between ticks unless the row
    // actually changed).
  }, [apiClient, taskRunId, snapshotUpdatedAt]);

  return { taskRun, loading, error };
}
