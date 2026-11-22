"use client";

import { useEffect, useMemo, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  parseUuidV7,
  visitThreadSchema,
} from "@scarn/api/frontend-contracts";
import type {
  NodeVisitContract,
  VisitThreadContract,
} from "@scarn/api/frontend-contracts";
import { latestVisitTask } from "./visit-status";

export type StepThreadData = {
  thread: VisitThreadContract | null;
  /** True while the first load for this visit is in flight; refetches keep
   * the current thread rendered. */
  loading: boolean;
  error: string;
};

/**
 * The key that refetches a visit's thread: the visit id plus its latest
 * task's id, status and completion and its questions' statuses, so the
 * thread reloads only when the execution poll reports a change to that
 * visit's work. `null` for no visit and for visits that run no task
 * (wait/succeed/fail), which have no thread.
 */
export function stepThreadRefreshKey(
  visit: Pick<
    NodeVisitContract,
    "id" | "nodeKind" | "tasks" | "questions"
  > | null,
): string | null {
  if (!visit || visit.nodeKind !== "step") return null;
  const task = latestVisitTask(visit);
  const questions = visit.questions
    .map((question) => question.status)
    .join(",");
  return `${visit.id}:${task?.taskId ?? ""}:${task?.status ?? ""}:${task?.completedAt ?? ""}:${questions}`;
}

/**
 * Loads every run of a visit's conversation, oldest first, from
 * `GET /pipeline-executions/:id/visits/:visitId/thread`. Fetches once per
 * `refreshKey`; a `null` visit or key fetches nothing.
 */
export function useStepThread(
  executionId: string,
  visitId: string | null,
  refreshKey: string | null,
): StepThreadData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [loaded, setLoaded] = useState<{
    target: string;
    thread: VisitThreadContract | null;
    error: string;
  } | null>(null);

  const target =
    visitId === null || refreshKey === null
      ? null
      : `${executionId}\u0000${visitId}`;

  useEffect(() => {
    if (target === null || visitId === null) return;
    const controller = new AbortController();

    const load = async () => {
      try {
        const data = await unwrapTreatyResponse(
          apiClient.api["pipeline-executions"]({
            pipelineExecutionId: parseUuidV7(executionId),
          })
            .visits({ visitId: parseUuidV7(visitId) })
            .thread.get(),
        );
        if (controller.signal.aborted) return;
        const parsed = visitThreadSchema.safeParse(data);
        setLoaded(
          parsed.success
            ? { target, thread: parsed.data, error: "" }
            : {
                target,
                thread: null,
                error: "Received invalid visit thread payload",
              },
        );
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setLoaded((current) => ({
          target,
          thread: current?.target === target ? current.thread : null,
          error:
            loadError instanceof Error
              ? loadError.message
              : "Failed to load the step thread",
        }));
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, [apiClient, executionId, visitId, target, refreshKey]);

  if (target === null) return { thread: null, loading: false, error: "" };
  const current = loaded?.target === target ? loaded : null;
  return {
    thread: current?.thread ?? null,
    loading: current === null,
    error: current?.error ?? "",
  };
}
