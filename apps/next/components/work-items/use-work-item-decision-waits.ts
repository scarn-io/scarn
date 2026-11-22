"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseUuidV7,
  pipelineExecutionSchema,
  type NodeVisitContract,
  type PipelineExecutionSummaryContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";

export type DecisionWait = {
  execution: PipelineExecutionSummaryContract;
  visit: NodeVisitContract;
};

/**
 * The decision waits open on a work item's runs: for each run waiting on a
 * decision, its waiting `wait` visits, read from `GET /pipeline-executions/:id`.
 * Re-reads when the set of runs or their statuses change.
 */
export function useWorkItemDecisionWaits(
  executions: readonly PipelineExecutionSummaryContract[],
): DecisionWait[] {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const waiting = useMemo(
    () =>
      executions.filter(
        (execution) =>
          execution.status === "waiting" && execution.waitingFor === "decision",
      ),
    [executions],
  );
  const key = waiting
    .map((execution) => `${execution.id}:${execution.updatedAt}`)
    .join(",");
  const [waits, setWaits] = useState<DecisionWait[]>([]);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  useEffect(() => {
    const waiting = waitingRef.current;
    if (key === "" || waiting.length === 0) {
      setWaits([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      waiting.map(async (execution) => {
        try {
          const data = await unwrapTreatyResponse(
            apiClient.api["pipeline-executions"]({
              pipelineExecutionId: parseUuidV7(execution.id),
            }).get(),
          );
          const parsed = pipelineExecutionSchema.safeParse(data);
          if (!parsed.success) return [];
          return parsed.data.visits
            .filter(
              (visit) =>
                visit.nodeKind === "wait" &&
                visit.status === "waiting" &&
                visit.waitFor === "decision",
            )
            .map((visit) => ({ execution, visit }));
        } catch {
          return [];
        }
      }),
    ).then((lists) => {
      if (!cancelled) setWaits(lists.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [apiClient, key]);

  return waits;
}
