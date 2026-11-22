"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { MAX_PROJECT_RUNS_LIMIT } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { usePolledLoad } from "@/components/use-polled-load";
import {
  RUNS_PAGE_SIZE,
  RUNS_POLL_MS,
  fetchProjectRuns,
  type ProjectRun,
  type RunsCounts,
} from "./runs-api";
import { runsQueryFromKey, runsQueryKey, type RunsQuery } from "./runs-params";

export type ProjectRunsData = {
  runs: ProjectRun[];
  counts: RunsCounts | null;
  /** Whether "Load more" has another page to fetch. */
  hasMore: boolean;
  /** True until the first page for the current query arrives. */
  loading: boolean;
  loadingMore: boolean;
  error: string;
  loadMore: () => void;
  refresh: () => void;
};

type Loaded = {
  key: string;
  runs: ProjectRun[];
  counts: RunsCounts | null;
  nextCursor: string | null;
  error: string;
};

/**
 * The Runs list for `query`, re-read every {@link RUNS_POLL_MS} while the tab
 * is visible and whenever an inbox action fires `notifyInboxChanged`.
 *
 * A refresh re-reads as many rows as are on screen, so a poll after "Load
 * more" keeps the extra pages, up to the API's page limit; past that the
 * list shrinks back to that limit and the cursor picks up from there.
 */
export function useProjectRuns(
  projectId: string,
  query: RunsQuery,
  pollIntervalMs: number = RUNS_POLL_MS,
): ProjectRunsData {
  const key = runsQueryKey(query);
  const stableQuery = useMemo(() => runsQueryFromKey(key), [key]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const shownRef = useRef({ key, count: RUNS_PAGE_SIZE });

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      const shown =
        shownRef.current.key === key ? shownRef.current.count : RUNS_PAGE_SIZE;
      const limit = Math.min(
        Math.max(shown, RUNS_PAGE_SIZE),
        MAX_PROJECT_RUNS_LIMIT,
      );
      try {
        const page = await fetchProjectRuns(projectId, stableQuery, {
          limit,
        });
        if (isCancelled()) return;
        setLoaded({
          key,
          runs: page.runs,
          counts: page.counts,
          nextCursor: page.nextCursor,
          error: "",
        });
      } catch {
        if (isCancelled()) return;
        setLoaded((previous) => ({
          key,
          runs: previous?.key === key ? previous.runs : [],
          counts: previous?.key === key ? previous.counts : null,
          nextCursor: previous?.key === key ? previous.nextCursor : null,
          error: "Could not load runs.",
        }));
      }
    },
    [projectId, key, stableQuery],
  );

  const refresh = usePolledLoad(load, true, pollIntervalMs);

  const current = loaded?.key === key ? loaded : null;
  const cursor = current?.nextCursor ?? null;
  const shownCount = current?.runs.length ?? 0;

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    fetchProjectRuns(projectId, stableQuery, { before: cursor })
      .then((page) => {
        shownRef.current = { key, count: shownCount + page.runs.length };
        setLoaded((previous) =>
          previous?.key === key && previous.nextCursor === cursor
            ? {
                ...previous,
                runs: [...previous.runs, ...page.runs],
                nextCursor: page.nextCursor,
                error: "",
              }
            : previous,
        );
      })
      .catch(() => {
        setLoaded((previous) =>
          previous?.key === key
            ? { ...previous, error: "Could not load more runs." }
            : previous,
        );
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [cursor, loadingMore, projectId, key, stableQuery, shownCount]);

  return {
    runs: current?.runs ?? [],
    counts: current?.counts ?? null,
    hasMore: Boolean(current?.nextCursor),
    loading: current === null,
    loadingMore,
    error: current?.error ?? "",
    loadMore,
    refresh,
  };
}
