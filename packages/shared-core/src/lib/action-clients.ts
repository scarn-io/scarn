import type { ApiResult, AuthHeaders } from "./api-result";
import type { RunWithVisits } from "./run-api-types";
import type { TaskDetail, TaskRunDetail } from "./task-api-types";
import type { WorkItemComment, WorkItemQuestion } from "./work-item-api-types";

/**
 * The slices of the generated `ScarnClient` the safe actions call. A real
 * client matches them at runtime but not structurally (see
 * `./api-result.ts`), so the CLI casts once per client with
 * `as unknown as <Client>`.
 */

/** `POST /pipeline-executions/{id}/visits/{visitId}/messages`. */
export type SentVisitMessage = {
  message: { id: string; taskId: string; body: string; createdAt: string };
  pipelineExecution: RunWithVisits;
};

type RunPath = { pipelineExecutionId: string };
type VisitPath = RunPath & { visitId: string };

export type RunActionClient = {
  pipelineExecutions: {
    getPipelineExecution: (options: {
      path: RunPath;
      headers: AuthHeaders;
    }) => Promise<ApiResult<RunWithVisits>>;
    rerunPipelineExecutionVisit: (options: {
      path: VisitPath;
      headers: AuthHeaders;
    }) => Promise<ApiResult<RunWithVisits>>;
    sendVisitMessage: (options: {
      path: VisitPath;
      body: { body: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<SentVisitMessage>>;
    cancelPipelineExecution: (options: {
      path: RunPath;
      headers: AuthHeaders;
    }) => Promise<ApiResult<RunWithVisits>>;
  };
};

export type TaskActionClient = {
  tasks: {
    getTask: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskDetail>>;
    getTaskRuns: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskRunDetail[]>>;
    retryTask: (options: {
      path: { taskId: string };
      body: { expectedLatestRunId: string | null };
      headers: AuthHeaders;
    }) => Promise<ApiResult<{ taskId: string; taskRunId: string | null }>>;
    cancelTask: (options: {
      path: { taskId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<{ taskId: string }>>;
  };
};

export type WorkItemActionClient = {
  workItemComments: {
    createWorkItemComment: (options: {
      body: { workItemId: string; body: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemComment>>;
  };
  workItems: {
    listWorkItemQuestions: (options: {
      path: { workItemId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemQuestion[]>>;
  };
  pipelineExecutions: {
    answerQuestion: (options: {
      path: { pipelineExecutionId: string; questionId: string };
      body: { body: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<WorkItemComment>>;
  };
};
