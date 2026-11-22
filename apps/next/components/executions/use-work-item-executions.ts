"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  MAX_PIPELINE_EXECUTIONS_PAGE_SIZE,
  pipelineDefinitionSchema,
  paginatedPipelineExecutionSummariesSchema,
  parseUuidV7,
} from "@scarn/api/frontend-contracts";
import type {
  PipelineDefinitionContract,
  PipelineExecutionSummaryContract,
} from "@scarn/api/frontend-contracts";
import { z } from "zod";

const pipelineDefinitionsSchema = z.array(pipelineDefinitionSchema);

export type WorkItemExecutionsData = {
  definitions: PipelineDefinitionContract[];
  definitionsById: Map<string, PipelineDefinitionContract>;
  executions: PipelineExecutionSummaryContract[];
  /**
   * Every execution of this work item, as counted by the server — not
   * `executions.length`. The two only differ past the page cap below, and the
   * header badge should stay honest if that ever happens.
   */
  total: number;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
};

/**
 * The work item detail page's executions: the header badge count and the
 * drawer's list.
 *
 * **One page, deliberately.** The drawer is a flat scroll of a single work
 * item's runs, and a work item accumulates executions one manual "New" click or
 * one pipeline trigger at a time — single digits in practice, against a cap of
 * 100. Paging controls in a drawer would be UI for a case that does not occur,
 * and the badge reads `pagination.total`, so the count stays exact even if it
 * ever does. If a work item does exceed the cap, the drawer shows the 100 most
 * recent runs and the badge still says how many there are.
 *
 * Both requests are the whole cost of opening a work item's executions. Before
 * this hook the page walked every page of the project's executions at
 * `pageSize=100` and filtered `workItemId` in the browser.
 */
export function useWorkItemExecutions(
  projectId: string,
  workItemId: string | null,
): WorkItemExecutionsData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [definitions, setDefinitions] = useState<PipelineDefinitionContract[]>(
    [],
  );
  const [executions, setExecutions] = useState<
    PipelineExecutionSummaryContract[]
  >([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (workItemId === null) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");

      try {
        const parsedProjectId = parseUuidV7(projectId);
        const [definitionsData, executionsData] = await Promise.all([
          unwrapTreatyResponse(
            apiClient.api
              .projects({ projectId: parsedProjectId })
              ["pipeline-definitions"].get(),
          ),
          unwrapTreatyResponse(
            apiClient.api["pipeline-executions"].get({
              query: {
                projectId: parsedProjectId,
                workItemId: parseUuidV7(workItemId),
                sort: "newest",
                page: 1,
                pageSize: MAX_PIPELINE_EXECUTIONS_PAGE_SIZE,
              },
            }),
          ),
        ]);

        if (signal?.cancelled) return;

        const definitionsResult =
          pipelineDefinitionsSchema.safeParse(definitionsData);
        if (!definitionsResult.success) {
          throw new Error("Received invalid pipeline definition payload");
        }
        const executionsResult =
          paginatedPipelineExecutionSummariesSchema.safeParse(executionsData);
        if (!executionsResult.success) {
          throw new Error("Received invalid pipeline execution payload");
        }

        setDefinitions(definitionsResult.data);
        setExecutions(executionsResult.data.items);
        setTotal(executionsResult.data.pagination.total);
        setLoading(false);
      } catch (loadError) {
        if (signal?.cancelled) return;
        setDefinitions([]);
        setExecutions([]);
        setTotal(0);
        setLoading(false);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load executions",
        );
      }
    },
    [apiClient, projectId, workItemId],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  const definitionsById = useMemo(
    () =>
      new Map<string, PipelineDefinitionContract>(
        definitions.map((definition) => [definition.id, definition]),
      ),
    [definitions],
  );

  return {
    definitions,
    definitionsById,
    executions,
    total,
    loading,
    error,
    refresh,
  };
}
