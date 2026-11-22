"use client";

import { useCallback, useState } from "react";
import { usePolledLoad } from "@/components/use-polled-load";
import {
  RUNS_POLL_MS,
  fetchProjectRun,
  type ProjectRun,
  type ProjectRunLookup,
} from "./runs-api";

export type ProjectRunData = {
  /** The row; `null` until it loads, or when it is not a row. */
  run: ProjectRun | null;
  /** True when the API says there is no such row of this kind. */
  notFound: boolean;
  error: string;
  refresh: () => void;
};

type Loaded = { key: string; run: ProjectRun | null; notFound: boolean; error: string };

// eslint-disable-next-line local/no-unknown-parameter-type
const statusOf = (error: unknown): number | null =>
  error !== null &&
  typeof error === "object" &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : null;

/**
 * One run's Runs-list row, for its page header: re-read every
 * {@link RUNS_POLL_MS} while the tab is visible and whenever an inbox action
 * fires `notifyInboxChanged`, so the header reads like the list does.
 */
export function useProjectRun(
  projectId: string,
  lookup: ProjectRunLookup,
  pollIntervalMs: number = RUNS_POLL_MS,
): ProjectRunData {
  const { type, id } = lookup;
  const key = `${type}:${id}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      try {
        const run = await fetchProjectRun(projectId, { type, id });
        if (isCancelled()) return;
        setLoaded({ key, run, notFound: false, error: "" });
      } catch (error) {
        if (isCancelled()) return;
        const notFound = statusOf(error) === 404;
        setLoaded((previous) => ({
          key,
          run: !notFound && previous?.key === key ? previous.run : null,
          notFound,
          error: notFound ? "" : "Could not load this run.",
        }));
      }
    },
    [projectId, key, type, id],
  );

  const refresh = usePolledLoad(load, true, pollIntervalMs);
  const current = loaded?.key === key ? loaded : null;

  return {
    run: current?.run ?? null,
    notFound: current?.notFound ?? false,
    error: current?.error ?? "",
    refresh,
  };
}
