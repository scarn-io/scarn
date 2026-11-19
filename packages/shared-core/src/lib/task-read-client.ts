import type { ApiResult } from "./api-result";
import type { ProjectTaskStatus } from "./work-item-api-types";
import type {
  TaskDetail,
  TaskKind,
  TaskRunArtifact,
  TaskRunDetail,
  TaskSummaryPage,
} from "./task-api-types";

/**
 * The slice of the generated `ScarnClient` that `tasks list`, `tasks view`
 * and `task-runs view` call. A real client matches it at runtime but not
 * structurally (the generated nullable fields are `unknown`; see
 * `./api-result.ts`), so the CLI casts once with
 * `as unknown as TaskReadClient`.
 */
export type TaskReadClient = {
  tasks: {
    listProjectTasks: (options: {
      path: { projectId: string };
      query: {
        status?: ProjectTaskStatus[];
        kind?: TaskKind;
        workItemId?: string;
        limit?: number;
      };
    }) => Promise<ApiResult<TaskSummaryPage>>;
    getTask: (options: {
      path: { taskId: string };
    }) => Promise<ApiResult<TaskDetail>>;
    getTaskRuns: (options: {
      path: { taskId: string };
    }) => Promise<ApiResult<TaskRunDetail[]>>;
  };
  taskRuns: {
    getTaskRun: (options: {
      path: { taskRunId: string };
    }) => Promise<ApiResult<TaskRunDetail>>;
    listTaskArtifacts: (options: {
      path: { taskRunId: string };
    }) => Promise<ApiResult<TaskRunArtifact[]>>;
  };
};
