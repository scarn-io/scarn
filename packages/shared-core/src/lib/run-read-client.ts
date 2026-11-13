import type {
  RunDisplayStatus,
  RunListPage,
  RunWithVisits,
  PipelineDefinitionSummary,
  VisitThread,
} from "./run-api-types";
import type { ApiResult, AuthHeaders } from "./api-result";

/**
 * The slice of the generated `ScarnClient` that `runs list` and
 * `runs thread` call. A real client matches it at runtime but not
 * structurally (the generated nullable fields are `unknown`; see
 * `./api-result.ts`), so the CLI casts once with
 * `as unknown as RunReadClient`.
 */
export type RunReadClient = {
  pipelineExecutions: {
    listPipelineExecutions: (options: {
      query: {
        projectId: string;
        pipelineId?: string;
        workItemId?: string;
        status?: RunDisplayStatus;
        sort?: "newest" | "oldest";
        page?: number;
        pageSize?: number;
      };
      headers: AuthHeaders;
    }) => Promise<ApiResult<RunListPage>>;
    getPipelineExecution: (options: {
      path: { pipelineExecutionId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<RunWithVisits>>;
    getVisitThread: (options: {
      path: { pipelineExecutionId: string; visitId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<VisitThread>>;
  };
  pipelineDefinitions: {
    listPipelineDefinitions: (options: {
      path: { projectId: string };
      query: { includeArchived?: boolean };
      headers: AuthHeaders;
    }) => Promise<ApiResult<PipelineDefinitionSummary[]>>;
  };
};
