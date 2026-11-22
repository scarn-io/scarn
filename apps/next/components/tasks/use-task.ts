"use client";

import { useCallback, useEffect, useState } from "react";
import type { TaskRunContract } from "@scarn/api/frontend-contracts";
import { useDeferWhileHidden } from "@/components/use-defer-while-hidden";
import {
  fetchTask,
  fetchTaskRuns,
  isTaskLive,
  type TaskDetail,
} from "./task-api";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; task: TaskDetail; runs: TaskRunContract[] };

/** Loads the task and runs together; refresh restarts polling after a retry. */
export function useTask(
  taskId: string,
  projectId: string,
  pollIntervalMs = 5000,
) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);
  const deferIfHidden = useDeferWhileHidden(reload);

  useEffect(() => {
    if (deferIfHidden()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [task, runs] = await Promise.all([
          fetchTask(taskId),
          fetchTaskRuns(taskId),
        ]);
        if (cancelled) return;
        if (task.projectId !== projectId) {
          setState({ status: "not-found" });
          return;
        }
        setState({ status: "ready", task, runs });
        if (isTaskLive(task.status) || task.status === "waiting_for_person") {
          timer = setTimeout(() => {
            if (!deferIfHidden()) reload();
          }, pollIntervalMs);
        }
      } catch {
        if (cancelled) return;
        setState((prev) =>
          prev.status === "ready"
            ? prev
            : { status: "error", message: "Failed to load task" },
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, projectId, pollIntervalMs, nonce, deferIfHidden, reload]);

  return { ...state, reload };
}
