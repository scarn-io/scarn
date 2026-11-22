"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useProjectPath,
  useProjectRoute,
} from "@/components/project-route-context";

const WORK_ITEM_PREFIX = "work-item:";

/** The work item a `from` query value points back to, if it names one. */
export function backFromWorkItemId(from: string | null): string | null {
  if (!from?.startsWith(WORK_ITEM_PREFIX)) return null;
  return from.slice(WORK_ITEM_PREFIX.length) || null;
}

const lastQueryKey = (projectId: string) =>
  `scarn:runs:last-query:${projectId}`;

/** Remembers a project's Runs list query string, so a run's page can go back to it. */
export function rememberRunsQuery(projectId: string, search: string): void {
  try {
    window.sessionStorage.setItem(lastQueryKey(projectId), search);
  } catch {
    return;
  }
}

/** The project's Runs list last query string, or "" when none is remembered. */
export function lastRunsQuery(projectId: string): string {
  try {
    return window.sessionStorage.getItem(lastQueryKey(projectId)) ?? "";
  } catch {
    return "";
  }
}

export type RunsBackTarget = { href: string; label: string };

/**
 * Where a run page's "Runs" crumb goes: the work item named by an explicit
 * `?from=work-item:{id}`, else the Runs list with its last query.
 */
export function useRunsBackTarget(): RunsBackTarget {
  const searchParams = useSearchParams();
  const projectPath = useProjectPath();
  const { projectId } = useProjectRoute();
  const [lastQuery, setLastQuery] = useState("");
  useEffect(() => {
    setLastQuery(lastRunsQuery(projectId));
  }, [projectId]);

  const workItemId = backFromWorkItemId(searchParams.get("from"));
  if (workItemId) {
    return { href: projectPath("work-items", workItemId), label: "Work item" };
  }
  const runs = projectPath("runs");
  return { href: lastQuery ? `${runs}?${lastQuery}` : runs, label: "Runs" };
}
