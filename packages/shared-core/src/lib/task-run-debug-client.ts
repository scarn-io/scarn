import type { ArtifactDownloadUrl } from "./api-types";
import type { ApiResult, AuthHeaders } from "./api-result";
import type {
  TaskRunArtifact,
  TaskRunArtifactFailure,
  TaskRunDetail,
} from "./task-api-types";
import type { TaskLogsClient } from "../load-task-log-lines";

/**
 * The slice of the generated `ScarnClient` that `scarn logs` and `scarn
 * artifacts` call. A real client matches it at runtime but not structurally
 * (the generated nullable fields are `unknown`; see `./api-result.ts`), so
 * the CLI casts once with `as unknown as TaskRunDebugClient`.
 */
export type TaskRunDebugClient = {
  tasks: {
    getTaskRuns: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskRunDetail[]>>;
  };
  taskRuns: TaskLogsClient["taskRuns"] & {
    getTaskRun: (options: {
      path: { taskRunId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskRunDetail>>;
    listTaskArtifacts: (options: {
      path: { taskRunId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskRunArtifact[]>>;
    listTaskArtifactFailures: (options: {
      path: { taskRunId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskRunArtifactFailure[]>>;
    getArtifactDownloadUrl: (options: {
      path: { taskRunId: string; artifactId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<ArtifactDownloadUrl>>;
  };
};
