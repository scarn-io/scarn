import type { ApiResult } from "./api-result";
import type { PipelineVersion } from "./pipeline-api-types";
import type { OverrulePreview, OverruleRequest } from "./route-api-types";
import type { RunWithVisits } from "./run-api-types";
import type { Grant } from "@scarn/sdk/definitions/steps";
import type {
  TaskDetail,
  TaskGrantRequest,
  TaskRunDetail,
} from "./task-api-types";
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
    }) => Promise<ApiResult<RunWithVisits>>;
    rerunPipelineExecutionVisit: (options: {
      path: VisitPath;
    }) => Promise<ApiResult<RunWithVisits>>;
    sendVisitMessage: (options: {
      path: VisitPath;
      body: { body: string };
    }) => Promise<ApiResult<SentVisitMessage>>;
    cancelPipelineExecution: (options: {
      path: RunPath;
    }) => Promise<ApiResult<RunWithVisits>>;
    overrulePipelineExecutionRoute: (options: {
      path: VisitPath;
      body: OverruleRequest;
    }) => Promise<ApiResult<RunWithVisits | { preview: OverrulePreview }>>;
  };
  pipelineDefinitions: {
    listPipelineDefinitionVersions: (options: {
      path: { pipelineDefinitionId: string };
    }) => Promise<ApiResult<Omit<PipelineVersion, "definition" | "steps">[]>>;
    getPipelineDefinitionVersion: (options: {
      path: { pipelineDefinitionId: string; version: number };
    }) => Promise<ApiResult<PipelineVersion>>;
  };
};

export type TaskActionClient = {
  tasks: {
    getTask: (options: {
      path: { taskId: string };
    }) => Promise<ApiResult<TaskDetail>>;
    getTaskRuns: (options: {
      path: { taskId: string };
    }) => Promise<ApiResult<TaskRunDetail[]>>;
    retryTask: (options: {
      path: { taskId: string };
      body: { expectedLatestRunId: string | null };
    }) => Promise<ApiResult<{ taskId: string; taskRunId: string | null }>>;
    cancelTask: (options: {
      path: { taskId: string };
    }) => Promise<ApiResult<{ taskId: string }>>;
  };
};

/** `scarn tasks access`: read a Task's grant requests and decide one. */
export type TaskAccessClient = {
  tasks: {
    listTaskGrantRequests: (options: {
      path: { taskId: string };
    }) => Promise<ApiResult<TaskGrantRequest[]>>;
    decideTaskGrantRequest: (options: {
      path: { grantRequestId: string };
      body: { approved: Grant[]; note?: string };
    }) => Promise<ApiResult<unknown>>;
  };
};

export type WorkItemActionClient = {
  workItemComments: {
    createWorkItemComment: (options: {
      body: { workItemId: string; body: string };
    }) => Promise<ApiResult<WorkItemComment>>;
  };
  workItems: {
    listWorkItemQuestions: (options: {
      path: { workItemId: string };
    }) => Promise<ApiResult<WorkItemQuestion[]>>;
  };
  pipelineExecutions: {
    answerQuestion: (options: {
      path: { pipelineExecutionId: string; questionId: string };
      body: { body: string };
    }) => Promise<ApiResult<WorkItemComment>>;
  };
};
