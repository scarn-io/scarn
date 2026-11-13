import { describeApiError } from "./lib/api-errors";
import type { ApiResult, AuthHeaders } from "./lib/api-result";
import type {
  ProjectTaskPage,
  WorkItemBlocks,
  WorkItemChild,
  WorkItemDetail,
  WorkItemRunPage,
  WorkItemQuestion,
} from "./lib/work-item-api-types";
import type { WorkItemReadClient } from "./lib/work-item-read-client";

/** How many of the latest pipeline runs and Tasks `work-items view` shows. */
export const WORK_ITEM_VIEW_RECENT_LIMIT = 5;

/** One sub-read of `work-items view`: loaded, or the reason it failed. */
export type WorkItemSection<T> =
  { status: "loaded"; data: T } | { status: "unavailable"; reason: string };

/** Everything `work-items view` reads, fetched in parallel. */
export type GatheredWorkItem = {
  workItem: WorkItemDetail;
  blocks: WorkItemSection<WorkItemBlocks>;
  children: WorkItemSection<WorkItemChild[]>;
  questions: WorkItemSection<WorkItemQuestion[]>;
  runs: WorkItemSection<WorkItemRunPage>;
  tasks: WorkItemSection<ProjectTaskPage>;
};

export type GatherWorkItemOptions = {
  client: WorkItemReadClient;
  headers: AuthHeaders;
  workItemId: string;
  projectId: string;
};

async function section<T>(
  request: () => Promise<ApiResult<T>>,
): Promise<WorkItemSection<T>> {
  try {
    const result = await request();
    return result.error === undefined
      ? { status: "loaded", data: result.data }
      : { status: "unavailable", reason: describeApiError(result.error) };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetches a work item and, in parallel, its blocks, children, questions and
 * latest pipeline runs and Tasks. The work item itself must load; any other
 * read that fails becomes an `unavailable` section instead of failing the
 * whole view.
 */
export async function gatherWorkItem(
  options: GatherWorkItemOptions,
): Promise<GatheredWorkItem> {
  const { client, headers, workItemId, projectId } = options;
  const path = { workItemId };
  const query = { workItemId };

  const [workItem, blocks, children, questions, runs, tasks] =
    await Promise.all([
      client.workItems.getWorkItem({ path, headers }),
      section(() =>
        client.workItemBlocks.listWorkItemBlocks({ query, headers }),
      ),
      section(() => client.workItems.listWorkItemChildren({ path, headers })),
      section(() => client.workItems.listWorkItemQuestions({ path, headers })),
      section(() =>
        client.pipelineExecutions.listPipelineExecutions({
          query: {
            projectId,
            workItemId,
            sort: "newest",
            pageSize: WORK_ITEM_VIEW_RECENT_LIMIT,
          },
          headers,
        }),
      ),
      section(() =>
        client.tasks.listProjectTasks({
          path: { projectId },
          query: { workItemId, limit: WORK_ITEM_VIEW_RECENT_LIMIT },
          headers,
        }),
      ),
    ]);

  if (workItem.error !== undefined) {
    throw new Error(
      `Could not load work item ${workItemId}: ${describeApiError(workItem.error)}`,
    );
  }

  return {
    workItem: workItem.data,
    blocks,
    children,
    questions,
    runs,
    tasks,
  };
}
