import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { claimTaskRuns } from "@scarn/core/tasks/task-run/application/claim-task-runs";
import { heartbeatTaskRunClaim } from "@scarn/core/tasks/task-run/application/heartbeat-task-run-claim";
import { getTaskRunWorkerContext } from "@scarn/core/tasks/task-run/application/get-task-run-worker-context";
import { reportTaskRunBaseCommit } from "@scarn/core/tasks/task-run/application/report-task-run-base-commit";
import { markTaskRunRunning } from "@scarn/core/tasks/task-run/application/mark-task-run-running";
import { getTaskRun } from "@scarn/core/tasks/task-run/application/get-task-run";
import { listTaskRunsByProjectId } from "@scarn/core/tasks/task-run/application/list-task-runs-by-project";
import { appendTaskLogs } from "@scarn/core/tasks/task-log/application/append-task-logs";
import { readTaskLogs } from "@scarn/core/tasks/task-log/application/read-task-logs";
import { getTaskLogArchive } from "@scarn/core/tasks/task-log/application/get-task-log-archive";
import {
  completeTaskAndAdvance,
  pipelineTerminalTaskRunHandlers,
  yieldTaskAndAdvance,
} from "@scarn/core/pipeline-executions/pipeline-run/application/task-and-advance";
import {
  appendTaskLogsInputSchema,
  appendTaskLogsResultSchema,
  readTaskLogsQuerySchema,
  readTaskLogsResultSchema,
  taskLogArchiveSchema,
} from "@scarn/core/tasks/task-log/contracts/task-log-contracts";
import {
  claimTaskRunsInputSchema,
  completeClaimedTaskRunInputSchema,
  getTaskRunWorkerContextInputSchema,
  reportTaskRunBaseCommitInputSchema,
  taskRunBaseCommitSchema,
  taskRunClaimCommandInputSchema,
  taskRunClaimSchema,
  taskRunSchema,
  taskRunHeartbeatSchema,
  taskRunWorkerContextSchema,
  yieldClaimedTaskRunInputSchema,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { createTaskRunArtifactRoutes } from "./task-run-artifacts";
import { createTaskRunArtifactFailureRoutes } from "./task-run-artifact-failures";
import { createTaskRunSessionRoutes } from "./task-run-sessions";
import { createTaskRunWorkItemRoutes } from "./task-run-work-items";
import {
  listTaskRunsQuerySchema,
  stdErrors,
  taskRunIdParamsSchema,
} from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

// The write side of `/task-runs`: everything a worker drives (claims,
// heartbeats, worker context, completions, yields, log appends). Always requires a
// real session — see `createTaskRunReadRoutes` below for the GET counterpart
// that also serves non-members of a public project.
const createTaskRunWriteRoutes = (appContext: AppContext) => {
  // Claims and heartbeats fail timed-out/abandoned task runs through these
  // handlers, which advance the pipeline run of the failed run.s Task.
  const terminalTaskRunHandlers = pipelineTerminalTaskRunHandlers(appContext);
  const claimDeps = {
    taskRunRepo: appContext.taskRunRepo,
    taskRepo: appContext.taskRepo,
    orgRepo: appContext.orgRepo,
    timeProvider: appContext.timeProvider,
    terminalTaskHandlers: terminalTaskRunHandlers,
    logFeedConnection: appContext.logFeedConnection,
  };

  return new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/claims",
      {
        body: claimTaskRunsInputSchema,
        response: responseSchemas({
          200: z.array(taskRunClaimSchema),
          400: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "claimTaskRuns", tags: ["TaskRuns"] },
      },
      async ({ body, auth }) =>
        await claimTaskRuns(claimTaskRunsInputSchema.parse(body), {
          userAuthz: auth.userAuthz,
          ...claimDeps,
        }),
    )
    .put(
      "/task-runs/:taskRunId/heartbeat",
      {
        params: taskRunIdParamsSchema,
        body: taskRunClaimCommandInputSchema,
        response: responseSchemas({
          200: taskRunHeartbeatSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "heartbeatTaskRun",
          tags: ["TaskRuns"],
          description:
            "Extends the worker's claim on the task run. `managedAuthority` is `ok`, or `{ lost: reason }` when a managed connection the run's launch pinned was disconnected, replaced or needs reconnecting: the worker should abort the run, which then fails with `ManagedConnectionAuthorityLost`.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await heartbeatTaskRunClaim(
            taskRunIdParamsSchema.parse(params).taskRunId,
            taskRunClaimCommandInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              ...claimDeps,
              managedLaunchRepo: appContext.managedLaunchRepo,
              managedConnectionRepo: appContext.managedConnectionRepo,
              managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/base-commit",
      {
        params: taskRunIdParamsSchema,
        body: reportTaskRunBaseCommitInputSchema,
        response: responseSchemas({
          200: taskRunBaseCommitSchema,
          400: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "reportTaskRunBaseCommit",
          tags: ["TaskRuns"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await reportTaskRunBaseCommit(
            taskRunIdParamsSchema.parse(params).taskRunId,
            reportTaskRunBaseCommitInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/worker-context",
      {
        params: taskRunIdParamsSchema,
        body: getTaskRunWorkerContextInputSchema,
        response: responseSchemas({
          200: taskRunWorkerContextSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getTaskRunWorkerContext", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await getTaskRunWorkerContext(
            taskRunIdParamsSchema.parse(params).taskRunId,
            getTaskRunWorkerContextInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              projectRepo: appContext.projectRepo,
              taskRepo: appContext.taskRepo,
              taskRunRepo: appContext.taskRunRepo,
              taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
              environmentRepo: appContext.environmentRepo,
              workItemRepo: appContext.workItemRepo,
              taskRunStepKeyReader: appContext.taskRunStepKeyReader,
              taskRunHistoryReader: appContext.taskRunHistoryReader,
              timeProvider: appContext.timeProvider,
              objectStore: appContext.objectStore,
              conversationRepo: appContext.conversationRepo,
              usernameReader: appContext.usernameReader,
              orgRepo: appContext.orgRepo,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/completions",
      {
        params: taskRunIdParamsSchema,
        body: completeClaimedTaskRunInputSchema,
        response: responseSchemas({
          200: taskRunSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "completeTaskRun", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await completeTaskAndAdvance(
            taskRunIdParamsSchema.parse(params).taskRunId,
            completeClaimedTaskRunInputSchema.parse(body),
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/yields",
      {
        params: taskRunIdParamsSchema,
        body: yieldClaimedTaskRunInputSchema,
        response: responseSchemas({
          200: taskRunSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "yieldTaskRun",
          tags: ["TaskRuns"],
          description:
            "Records that the task run's agent ended its turn with a yield; the task run ends `yielded`. It hands the conversation to a person: when it belongs to a pipeline run, the run posts `message` to the step visit's conversation and waits for a reply. Requires the claim token and `executions:write`.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await yieldTaskAndAdvance(
            taskRunIdParamsSchema.parse(params).taskRunId,
            yieldClaimedTaskRunInputSchema.parse(body),
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .put(
      "/task-runs/:taskRunId/running",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: taskRunSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "markTaskRunRunning", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await markTaskRunRunning(
            taskRunIdParamsSchema.parse(params).taskRunId,
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              taskRepo: appContext.taskRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/logs",
      {
        params: taskRunIdParamsSchema,
        body: appendTaskLogsInputSchema,
        response: responseSchemas({
          200: appendTaskLogsResultSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          413: apiErrorResponseSchema,
          429: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "appendTaskLogs", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await appendTaskLogs(
            taskRunIdParamsSchema.parse(params).taskRunId,
            appendTaskLogsInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              logFeedStore: appContext.logFeedStore,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );
};

// The read side of `/task-runs`: serves non-members of a public
// project — including fully anonymous callers — via
// `createOptionallyAuthenticated`. `getTaskLogArchive` internally
// checks `ProjectPermissionGrant.isPublicNonMemberGrant` to keep these reads
// out of the owning org's usage-quota accounting (see issue #149).
const createTaskRunReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/task-runs/:taskRunId",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: taskRunSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getTaskRun", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getTaskRun(taskRunIdParamsSchema.parse(params).taskRunId, {
            userAuthz: auth.userAuthz,
            taskRunRepo: appContext.taskRunRepo,
          }),
        ),
    )
    .get(
      "/task-runs",
      {
        query: listTaskRunsQuerySchema,
        response: responseSchemas({
          200: z.array(taskRunSchema),
          ...stdErrors,
        }),
        detail: { operationId: "listTaskRuns", tags: ["TaskRuns"] },
      },
      async ({ query, auth }) =>
        await listTaskRunsByProjectId(
          listTaskRunsQuerySchema.parse(query).projectId,
          {
            userAuthz: auth.userAuthz,
            taskRunRepo: appContext.taskRunRepo,
          },
        ),
    )
    .get(
      "/task-runs/:taskRunId/logs",
      {
        params: taskRunIdParamsSchema,
        query: readTaskLogsQuerySchema,
        response: responseSchemas({
          200: readTaskLogsResultSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "readTaskLogs", tags: ["TaskRuns"] },
      },
      async ({ params, query, auth }) =>
        Result.unwrap(
          await readTaskLogs(
            taskRunIdParamsSchema.parse(params).taskRunId,
            readTaskLogsQuerySchema.parse(query),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              logFeedStore: appContext.logFeedStore,
            },
          ),
        ),
    )
    .get(
      "/task-runs/:taskRunId/logs/archive",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: taskLogArchiveSchema,
          402: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getTaskLogArchive", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getTaskLogArchive(
            taskRunIdParamsSchema.parse(params).taskRunId,
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              objectStore: appContext.objectStore,
              timeProvider: appContext.timeProvider,
              orgRepo: appContext.orgRepo,
              usageMeterRepo: appContext.usageMeterRepo,
              domainEventDispatcher: appContext.domainEventDispatcher,
              logger: appContext.logger,
            },
          ),
        ),
    );

export const createTaskRunsRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createTaskRunWriteRoutes(appContext))
    .use(createTaskRunReadRoutes(appContext))
    .use(
      new Elysia()
        .use(createTaskRunSessionRoutes(appContext))
        .use(createTaskRunWorkItemRoutes(appContext)),
    )
    .use(createTaskRunArtifactRoutes(appContext))
    .use(createTaskRunArtifactFailureRoutes(appContext));
