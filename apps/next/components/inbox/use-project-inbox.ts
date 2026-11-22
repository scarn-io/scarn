"use client";

import { useCallback, useState } from "react";
import type { TaskSummary } from "@/components/tasks/task-api";
import { usePolledLoad } from "@/components/use-polled-load";
import {
  INBOX_POLL_MS,
  fetchInboxSummary,
  fetchInboxWaits,
  fetchMyFailedTasks,
  fetchTasksWaitingOnMe,
  type InboxSummary,
  type InboxWait,
  type InboxWorkItem,
} from "./inbox-api";

/** The Inbox tab's badge count; `0` until loaded, and for a non-member (`projectId` null). */
export function useInboxBadgeCount(
  projectId: string | null,
  pollIntervalMs: number = INBOX_POLL_MS,
): number {
  const [count, setCount] = useState(0);
  const load = useCallback(
    async (isCancelled: () => boolean) => {
      if (!projectId) return;
      try {
        const summary = await fetchInboxSummary(projectId);
        if (!isCancelled()) setCount(summary.badgeCount);
      } catch {
        return;
      }
    },
    [projectId],
  );
  usePolledLoad(load, projectId !== null, pollIntervalMs);
  return projectId ? count : 0;
}

export type ProjectInboxData = {
  waitingTasks: TaskSummary[];
  waits: InboxWait[];
  workItems: InboxWorkItem[];
  failedTasks: TaskSummary[];
  summary: InboxSummary | null;
  loading: boolean;
  error: string;
  refresh: () => void;
};

/** Everything the Inbox page lists, re-read on an interval and after actions. */
export function useProjectInbox(
  projectId: string,
  pollIntervalMs: number = INBOX_POLL_MS,
): ProjectInboxData {
  const [data, setData] = useState<
    Omit<ProjectInboxData, "loading" | "error" | "refresh">
  >({
    waitingTasks: [],
    waits: [],
    workItems: [],
    failedTasks: [],
    summary: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const [waitingTasks, inboxWaits, failedTasks, summary] =
          await Promise.all([
            fetchTasksWaitingOnMe(projectId),
            fetchInboxWaits(projectId),
            fetchMyFailedTasks(projectId),
            fetchInboxSummary(projectId),
          ]);
        if (isCancelled()) return;
        setData({
          waitingTasks,
          waits: inboxWaits.waits,
          workItems: inboxWaits.workItems,
          failedTasks,
          summary,
        });
        setError("");
      } catch {
        if (!isCancelled()) setError("Could not load your inbox.");
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [projectId],
  );
  const refresh = usePolledLoad(load, true, pollIntervalMs);

  return { ...data, loading, error, refresh };
}
