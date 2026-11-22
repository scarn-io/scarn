import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { cancelPipelineRun } from "@scarn/core/pipeline-executions/pipeline-run/application/cancel-pipeline-run";
import { cancelTask } from "@scarn/core/tasks/task/application/cancel-task";
import { createTask } from "@scarn/core/tasks/task/application/create-task";
import { getTask } from "@scarn/core/tasks/task/application/get-task";
import { listProjectTasks } from "@scarn/core/tasks/task/application/list-project-tasks";
import { listTaskRuns } from "@scarn/core/tasks/task/application/list-task-runs";
import { retryTask } from "@scarn/core/tasks/task/application/retry-task";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import {
  createTaskInputSchema,
  createdTaskSchema,
  getTaskInputSchema,
  retriedTaskSchema,
  retryTaskInputSchema,
  taskRunsListSchema,
} from "@scarn/core/tasks/task/contracts/task-contracts";
import {
  listProjectTasksQuerySchema,
  projectTasksPageSchema,
  taskDetailSchema,
} from "@scarn/core/tasks/task/contracts/task-summary-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { keepRepeatedQueryKeys } from "../repeated-query-keys";
import { responseSchemas } from "../response-schemas";

const taskIdParamsSchema = z.object({
  taskId: getTaskInputSchema,
});

const cancelledTaskSchema = z.object({ taskId: getTaskInputSchema });
const retryTaskBodySchema = retryTaskInputSchema.omit({ taskId: true });

const createTaskWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/tasks",
      {
        body: createTaskInputSchema,
        response: responseSchemas({
          200: createdTaskSchema,
          400: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "createTask",
          description:
            "Starts a standalone Task from a step-definition version or a prompt. `environment.name` runs it in that named environment instead of the step's own or the repo default, and `environment.extraConnectors` adds catalog connectors for this Task only. Responds 422 `ENVIRONMENT_OVERRIDE_INLINE` when the step has an inline environment, `ENVIRONMENT_NOT_FOUND`, `ENVIRONMENT_OVERRIDE_INCOMPATIBLE` when the environment doesn't fit the step, and `CONNECTOR_NOT_FOUND`, `CONNECTOR_ALREADY_PRESENT` or `CONNECTOR_VAR_MISSING` for an extra connector. Responds 409 `Scarn.ConcurrencyGroupFull` when the step's concurrency group on the work item is full: no Task is created, and `meta.heldBy` names the Tasks that hold the group.",
          tags: ["Tasks"],
        },
      },
      async ({ body, auth }) =>
        await createTask(createTaskInputSchema.parse(body), {
          userAuthz: auth.userAuthz,
          taskRepo: appContext.taskRepo,
          taskRunRepo: appContext.taskRunRepo,
          stepDefinitionRepo: appContext.stepDefinitionRepo,
          workItemRepo: appContext.workItemRepo,
          workItemBlockRepo: appContext.workItemBlockRepo,
          taskGroup: appContext.taskGroup,
          environmentRepo: appContext.environmentRepo,
          taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
          timeProvider: appContext.timeProvider,
          workNotifier: appContext.workNotifier,
        }),
    )
    .post(
      "/tasks/:taskId/cancel",
      {
        params: taskIdParamsSchema,
        response: responseSchemas({
          200: cancelledTaskSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "cancelTask",
          description:
            "Stops an agent or MCP tool Task: it ends `cancelled`. Requires `executions:write` on the Task's project. A Task a pipeline step owns is stopped by cancelling its whole pipeline execution. Responds 422 `TASK_CANCEL_CODE_TASK` for a code Task and 422 `TASK_ALREADY_ENDED` for a Task that already ended.",
          tags: ["Tasks"],
        },
      },
      async ({ params, auth }) => {
        const deps = { ...appContext, userAuthz: auth.userAuthz };
        return Result.unwrap(
          await cancelTask(taskIdParamsSchema.parse(params).taskId, {
            ...deps,
            pipelineRunCancel: {
              cancelRun: async (pipelineRunId) => {
                Result.unwrap(await cancelPipelineRun(pipelineRunId, deps));
              },
            },
          }),
        );
      },
    )
    .post(
      "/tasks/:taskId/retry",
      {
        params: taskIdParamsSchema,
        body: retryTaskBodySchema,
        response: responseSchemas({
          200: retriedTaskSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "retryTask",
          description:
            "Retries a failed or cancelled standalone Task in place. Requires executions:write on its project. Pipeline-owned Tasks must be rerun through their pipeline. The required nullable expectedLatestRunId must match the latest run (null only when no run exists); stale requests return 409. Cancelled Tasks without runs restart their initial attempt, remaining waiting_for_work with taskRunId null while blockers are open. Existing attempts retry despite later blockers. Returns 422 for unsupported Tasks or states and 409 when the concurrency group is full.",
          tags: ["Tasks"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await retryTask(
            { ...body, taskId: taskIdParamsSchema.parse(params).taskId },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    );

// Read-only, so these also serve non-members of a public project.
const createTaskReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/tasks/:taskId",
      {
        params: taskIdParamsSchema,
        response: responseSchemas({
          200: taskDetailSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getTask", tags: ["Tasks"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getTask(taskIdParamsSchema.parse(params).taskId, {
            userAuthz: auth.userAuthz,
            taskRepo: appContext.taskRepo,
            taskSummaryReader: appContext.taskSummaryReader,
            usernameReader: appContext.usernameReader,
          }),
        ),
    )
    .get(
      "/tasks/:taskId/runs",
      {
        params: taskIdParamsSchema,
        response: responseSchemas({
          200: taskRunsListSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getTaskRuns", tags: ["Tasks"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listTaskRuns(taskIdParamsSchema.parse(params).taskId, {
            userAuthz: auth.userAuthz,
            taskRepo: appContext.taskRepo,
            taskRunRepo: appContext.taskRunRepo,
          }),
        ),
    )
    .get(
      "/projects/:projectId/tasks",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        query: listProjectTasksQuerySchema,
        transform: keepRepeatedQueryKeys("status", "workItemId"),
        response: responseSchemas({
          200: projectTasksPageSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "listProjectTasks", tags: ["Tasks"] },
      },
      async ({ params: { projectId }, query, auth }) =>
        Result.unwrap(
          await listProjectTasks(projectId, query, {
            userAuthz: auth.userAuthz,
            projectRepo: appContext.projectRepo,
            taskSummaryReader: appContext.taskSummaryReader,
            usernameReader: appContext.usernameReader,
          }),
        ),
    );

export const createTasksRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createTaskWriteRoutes(appContext))
    .use(createTaskReadRoutes(appContext));
