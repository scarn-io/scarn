import { describeApiError } from "./lib/api-errors";
import type {
  RunDisplayStatus,
  RunListPage,
  RunVisit,
  PipelineDefinitionSummary,
  VisitThread,
} from "./lib/run-api-types";
import type { RunReadClient } from "./lib/run-read-client";
import { resolveStepVisit } from "./lib/run-visits";
import type { ApiResult, AuthHeaders } from "./lib/api-result";

/**
 * The reads behind `runs list` and `runs thread`: pure data that
 * {@link formatRunList} / {@link formatVisitThread} render.
 */

function unwrap<T>(what: string, result: ApiResult<T>): T {
  if (result.error !== undefined) {
    throw new Error(
      `Could not load ${what}: ${describeApiError(result.error)}`,
    );
  }
  return result.data;
}

/** Picks the pipeline `ref` names, by id or key. */
export function findPipelineDefinition<T extends PipelineDefinitionSummary>(
  definitions: readonly T[],
  ref: string,
): T {
  const found =
    definitions.find((definition) => definition.id === ref) ??
    definitions.find((definition) => definition.key === ref);
  if (found === undefined) {
    const known =
      definitions.map((definition) => definition.key).join(", ") || "(none)";
    throw new Error(
      `No pipeline "${ref}" in this project. Pipelines: ${known}.`,
    );
  }
  return found;
}

export type GatherRunListOptions = {
  client: RunReadClient;
  headers: AuthHeaders;
  projectId: string;
  /** A pipeline key or id. */
  pipeline?: string;
  workItemId?: string;
  status?: RunDisplayStatus;
  limit: number;
};

export type GatheredRunList = {
  page: RunListPage;
  /** Pipeline key by pipeline definition id, for labelling rows. */
  pipelineKeys: Record<string, string>;
};

/** One page of the project's pipeline runs, newest first. */
export async function gatherRunList(
  options: GatherRunListOptions,
): Promise<GatheredRunList> {
  const { client, headers, projectId } = options;
  const definitions = unwrap(
    "pipelines",
    await client.pipelineDefinitions.listPipelineDefinitions({
      path: { projectId },
      query: { includeArchived: true },
      headers,
    }),
  );
  const pipelineId =
    options.pipeline === undefined
      ? undefined
      : findPipelineDefinition(definitions, options.pipeline).id;
  const page = unwrap(
    "pipeline runs",
    await client.pipelineExecutions.listPipelineExecutions({
      query: {
        projectId,
        pipelineId,
        workItemId: options.workItemId,
        status: options.status,
        sort: "newest",
        page: 1,
        pageSize: options.limit,
      },
      headers,
    }),
  );
  const pipelineKeys = Object.fromEntries(
    definitions.map((definition) => [definition.id, definition.key]),
  );
  return { page, pipelineKeys };
}

export type GatherVisitThreadOptions = {
  client: RunReadClient;
  headers: AuthHeaders;
  runId: string;
  stepKey: string;
  /** Which visit to the step, 1-based oldest first; defaults to the latest. */
  attempt?: number;
};

export type GatheredVisitThread = {
  runId: string;
  stepKey: string;
  attemptNumber: number;
  attemptCount: number;
  visit: RunVisit;
  thread: VisitThread;
};

/** The message thread of one step visit. */
export async function gatherVisitThread(
  options: GatherVisitThreadOptions,
): Promise<GatheredVisitThread> {
  const { client, headers, runId, stepKey } = options;
  const result = await client.pipelineExecutions.getPipelineExecution({
    path: { pipelineExecutionId: runId },
    headers,
  });
  if (result.error?.status === 404) {
    throw new Error(`Pipeline run ${runId} not found.`);
  }
  const run = unwrap(`pipeline run ${runId}`, result);
  const resolved = resolveStepVisit(run, stepKey, options.attempt);
  if (resolved.visit.nodeKind !== "step") {
    throw new Error(
      `"${stepKey}" is a ${resolved.visit.nodeKind} node; only step nodes have a message thread.`,
    );
  }
  const thread = unwrap(
    `the thread of visit ${resolved.visit.id}`,
    await client.pipelineExecutions.getVisitThread({
      path: { pipelineExecutionId: runId, visitId: resolved.visit.id },
      headers,
    }),
  );
  return { runId, stepKey, ...resolved, thread };
}
