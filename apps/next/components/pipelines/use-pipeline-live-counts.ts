"use client";

import { useCallback, useState } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { PipelineLiveCountsContract } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import { fetchProjectRuns } from "@/components/runs/runs-api";
import { usePolledLoad } from "@/components/use-polled-load";

export const LIVE_COUNTS_POLL_MS = 20_000;

export type PipelineLiveCounts =
  PipelineLiveCountsContract["pipelines"][number];
export type NodeLiveCounts = PipelineLiveCounts["nodes"][string];

export type ProjectLiveCounts = {
  /** By pipeline definition id. */
  pipelines: ReadonlyMap<string, PipelineLiveCounts>;
  /** In-progress runs by automation id. */
  automations: ReadonlyMap<string, number>;
};

const EMPTY: ProjectLiveCounts = {
  pipelines: new Map(),
  automations: new Map(),
};

async function fetchPipelineLiveCounts(
  projectId: string,
): Promise<PipelineLiveCountsContract> {
  return await unwrapTreatyResponse(
    getBrowserScarnApiClient()
      .api.projects({ projectId: parseUuidV7(projectId) })
      ["pipeline-definitions"]["live-counts"].get(),
  );
}

/**
 * The page's live counts: per pipeline and node from the live-counts
 * endpoint, and per automation from the Runs list's `startedBy` facet. One
 * call of each per poll, re-read every {@link LIVE_COUNTS_POLL_MS} while the
 * tab is visible. A failed call keeps the last counts it had.
 */
export function useProjectLiveCounts(
  projectId: string,
  pollIntervalMs: number = LIVE_COUNTS_POLL_MS,
): ProjectLiveCounts {
  const [counts, setCounts] = useState<ProjectLiveCounts>(EMPTY);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      const [pipelines, runs] = await Promise.allSettled([
        fetchPipelineLiveCounts(projectId),
        fetchProjectRuns(projectId, { status: "open" }, { limit: 1 }),
      ]);
      if (isCancelled()) return;
      setCounts((previous) => ({
        pipelines:
          pipelines.status === "fulfilled"
            ? new Map(
                pipelines.value.pipelines.map((entry) => [
                  entry.pipelineDefinitionId,
                  entry,
                ]),
              )
            : previous.pipelines,
        automations:
          runs.status === "fulfilled"
            ? new Map(
                runs.value.counts.startedBy
                  .filter((entry) => entry.filter !== "me")
                  .map((entry) => [entry.filter, entry.inProgress]),
              )
            : previous.automations,
      }));
    },
    [projectId],
  );

  usePolledLoad(load, true, pollIntervalMs);

  return counts;
}
