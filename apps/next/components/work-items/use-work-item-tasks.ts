"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { MAX_PROJECT_TASKS_LIMIT } from "@scarn/core/tasks/task/contracts/task-summary-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import { isTaskLive, type TaskSummary } from "@/components/tasks/task-api";
import { useDeferWhileHidden } from "@/components/use-defer-while-hidden";

export const WORK_ITEM_TASKS_POLL_MS = 5000;

export type WorkItemTasksData = {
  /** Newest first. */
  tasks: TaskSummary[];
  loading: boolean;
  error: string;
  refresh: () => void;
};

const isStillMoving = (task: TaskSummary) =>
  isTaskLive(task.status) || task.status === "waiting_for_person";

/**
 * A work item's Tasks from `GET /projects/:pid/tasks?workItemId=`, newest
 * first (up to the list cap). Polls while any Task is still moving, so the
 * agents panel and status ring follow a run without a reload.
 */
export function useWorkItemTasks(
  projectId: string,
  workItemId: string,
  pollIntervalMs: number = WORK_ITEM_TASKS_POLL_MS,
): WorkItemTasksData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);
  const deferIfHidden = useDeferWhileHidden(refresh);

  useEffect(() => {
    if (deferIfHidden()) return;
    let cancelled = false;
    const load = async () => {
      try {
        const page = await unwrapTreatyResponse(
          apiClient.api
            .projects({ projectId: parseUuidV7(projectId) })
            .tasks.get({
              query: {
                workItemId: parseUuidV7(workItemId),
                limit: MAX_PROJECT_TASKS_LIMIT,
              },
            }),
        );
        if (cancelled) return;
        setTasks(page.tasks);
        setError("");
        if (page.tasks.some(isStillMoving)) {
          timer.current = setTimeout(() => {
            if (!deferIfHidden()) refresh();
          }, pollIntervalMs);
        }
      } catch {
        if (!cancelled) setError("Failed to load tasks");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [
    apiClient,
    projectId,
    workItemId,
    nonce,
    pollIntervalMs,
    deferIfHidden,
    refresh,
  ]);

  return { tasks, loading, error, refresh };
}
