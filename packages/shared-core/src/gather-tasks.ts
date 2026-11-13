import { describeApiError } from "./lib/api-errors";
import type { ApiResult, AuthHeaders } from "./lib/api-result";
import type {
  TaskDetail,
  TaskKind,
  TaskRunArtifact,
  TaskRunDetail,
  TaskSummaryPage,
} from "./lib/task-api-types";
import type { TaskReadClient } from "./lib/task-read-client";
import type { ProjectTaskStatus } from "./lib/work-item-api-types";

/**
 * The reads behind `tasks list`, `tasks view` and `task-runs view`: pure
 * data that `./format-tasks.ts` renders.
 */

/** How far `tasks view` follows `previousTaskId` back. */
export const PREVIOUS_TASK_CHAIN_LIMIT = 10;

/** One optional sub-read: loaded, or the reason it failed. */
export type TaskSection<T> =
  { status: "loaded"; data: T } | { status: "unavailable"; reason: string };

function unwrap<T>(what: string, result: ApiResult<T>): T {
  if (result.error?.status === 404) {
    throw new Error(`${what} not found.`);
  }
  if (result.error !== undefined) {
    throw new Error(
      `Could not load ${what}: ${describeApiError(result.error)}`,
    );
  }
  return result.data;
}

async function section<T>(
  request: () => Promise<ApiResult<T>>,
): Promise<TaskSection<T>> {
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

export type GatherTaskListOptions = {
  client: TaskReadClient;
  headers: AuthHeaders;
  projectId: string;
  workItemId?: string;
  statuses?: ProjectTaskStatus[];
  kind?: TaskKind;
  limit: number;
};

/** One page of the project's Tasks, newest first. */
export async function gatherTaskList(
  options: GatherTaskListOptions,
): Promise<TaskSummaryPage> {
  const { client, headers, projectId } = options;
  return unwrap(
    "Tasks",
    await client.tasks.listProjectTasks({
      path: { projectId },
      query: {
        status:
          options.statuses === undefined || options.statuses.length === 0
            ? undefined
            : options.statuses,
        kind: options.kind,
        workItemId: options.workItemId,
        limit: options.limit,
      },
      headers,
    }),
  );
}

export type GatherTaskViewOptions = {
  client: TaskReadClient;
  headers: AuthHeaders;
  taskId: string;
};

export type GatheredTaskView = {
  task: TaskDetail;
  /** The Task's runs, oldest first. */
  runs: TaskSection<TaskRunDetail[]>;
  /** The Tasks reached through `previousTaskId`, newest first. */
  previousTasks: TaskDetail[];
  /** Set when the walk back stopped before the first Task. */
  previousTasksCutOff: string | null;
};

/**
 * A Task, its runs, and the Tasks before it (through `previousTaskId`). The
 * Task itself must load; its runs and the earlier Tasks are best effort.
 */
export async function gatherTaskView(
  options: GatherTaskViewOptions,
): Promise<GatheredTaskView> {
  const { client, headers, taskId } = options;
  const [taskResult, runs] = await Promise.all([
    client.tasks.getTask({ path: { taskId }, headers }),
    section(() => client.tasks.getTaskRuns({ path: { taskId }, headers })),
  ]);
  const task = unwrap(`Task ${taskId}`, taskResult);

  const previousTasks: TaskDetail[] = [];
  let previousTasksCutOff: string | null = null;
  let nextId = task.previousTaskId;
  while (nextId !== null) {
    if (previousTasks.length >= PREVIOUS_TASK_CHAIN_LIMIT) {
      previousTasksCutOff = `stopped after ${String(PREVIOUS_TASK_CHAIN_LIMIT)} earlier Tasks; next is ${nextId}`;
      break;
    }
    const previousId = nextId;
    const previous = await section(() =>
      client.tasks.getTask({ path: { taskId: previousId }, headers }),
    );
    if (previous.status === "unavailable") {
      previousTasksCutOff = `could not load Task ${previousId}: ${previous.reason}`;
      break;
    }
    previousTasks.push(previous.data);
    nextId = previous.data.previousTaskId;
  }
  return { task, runs, previousTasks, previousTasksCutOff };
}

export type GatherTaskRunViewOptions = {
  client: TaskReadClient;
  headers: AuthHeaders;
  taskRunId: string;
};

export type GatheredTaskRunView = {
  run: TaskRunDetail;
  artifacts: TaskSection<TaskRunArtifact[]>;
};

/** A Task run and, best effort, the artifacts it recorded. */
export async function gatherTaskRunView(
  options: GatherTaskRunViewOptions,
): Promise<GatheredTaskRunView> {
  const { client, headers, taskRunId } = options;
  const [runResult, artifacts] = await Promise.all([
    client.taskRuns.getTaskRun({ path: { taskRunId }, headers }),
    section(() =>
      client.taskRuns.listTaskArtifacts({ path: { taskRunId }, headers }),
    ),
  ]);
  return { run: unwrap(`Task run ${taskRunId}`, runResult), artifacts };
}
