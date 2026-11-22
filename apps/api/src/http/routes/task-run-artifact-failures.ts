import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { recordTaskArtifactFailure } from "@scarn/core/tasks/task-artifact/application/record-task-artifact-failure";
import { listTaskArtifactFailures } from "@scarn/core/tasks/task-artifact/application/list-task-artifact-failures";
import {
  artifactFailureSchema,
  recordArtifactFailureInputSchema,
} from "@scarn/core/tasks/task-artifact/contracts/task-artifact-failure-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

// The write side: recording a failed artifact-upload attempt reported by the
// owning worker. Always requires a real session — see
// `createTaskRunArtifactFailureReadRoutes` below for the GET
// counterpart that also serves non-members of a public project. No `402`
// here (unlike `record-task-artifact`'s upload-url mint): recording
// a failure never itself consumes storage quota — nothing was actually
// stored.
const createTaskRunArtifactFailureWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/:taskRunId/artifact-failures",
      {
        params: taskRunIdParamsSchema,
        body: recordArtifactFailureInputSchema,
        response: responseSchemas({
          200: artifactFailureSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "recordTaskArtifactFailure",
          tags: ["TaskRuns"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await recordTaskArtifactFailure(
            taskRunIdParamsSchema.parse(params).taskRunId,
            recordArtifactFailureInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactFailureRepo: appContext.artifactFailureRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );

// The read side: listing recorded upload failures. Serves non-members of a
// public project — including fully anonymous callers — via
// `createOptionallyAuthenticated`, mirroring `createTaskRunArtifactReadRoutes`
// in `task-artifacts.ts`.
const createTaskRunArtifactFailureReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/task-runs/:taskRunId/artifact-failures",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: z.array(artifactFailureSchema),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listTaskArtifactFailures",
          tags: ["TaskRuns"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listTaskArtifactFailures(
            taskRunIdParamsSchema.parse(params).taskRunId,
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactFailureRepo: appContext.artifactFailureRepo,
            },
          ),
        ),
    );

export const createTaskRunArtifactFailureRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createTaskRunArtifactFailureWriteRoutes(appContext))
    .use(createTaskRunArtifactFailureReadRoutes(appContext));
