import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { listProjectArtifacts } from "@scarn/core/tasks/task-artifact/application/list-project-artifacts";
import {
  deleteProjectArtifact,
  deleteProjectArtifacts,
} from "@scarn/core/tasks/task-artifact/application/delete-project-artifacts";
import { getProjectArtifact } from "@scarn/core/tasks/task-artifact/application/get-project-artifact";
import {
  deleteProjectArtifactsInputSchema,
  listProjectArtifactsResponseSchema,
  projectArtifactDetailSchema,
} from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const projectArtifactsParamsSchema = z.object({ projectId: uuidV7Schema });
const projectArtifactItemParamsSchema = z.object({
  projectId: uuidV7Schema,
  artifactId: uuidV7Schema,
});
const deleteProjectArtifactsBodySchema = z.object({
  input: deleteProjectArtifactsInputSchema,
});

export const createProjectArtifactsRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/artifacts",
      {
        params: projectArtifactsParamsSchema,
        response: responseSchemas({
          200: listProjectArtifactsResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listProjectArtifacts",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId } = projectArtifactsParamsSchema.parse(params);
        return await listProjectArtifacts(projectId, {
          userAuthz: auth.userAuthz,
          artifactRepo: appContext.artifactRepo,
        });
      },
    )
    .get(
      "/projects/:projectId/artifacts/:artifactId",
      {
        params: projectArtifactItemParamsSchema,
        response: responseSchemas({
          200: projectArtifactDetailSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getProjectArtifact",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, artifactId } =
          projectArtifactItemParamsSchema.parse(params);
        return Result.unwrap(
          await getProjectArtifact(projectId, artifactId, {
            userAuthz: auth.userAuthz,
            artifactRepo: appContext.artifactRepo,
          }),
        );
      },
    )
    // Registered before the `:artifactId` delete route below: "batch" is a
    // static segment and must not be swallowed by the dynamic param match.
    .delete(
      "/projects/:projectId/artifacts/batch",
      {
        params: projectArtifactsParamsSchema,
        body: deleteProjectArtifactsBodySchema,
        response: responseSchemas({
          200: z.number(),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "deleteProjectArtifacts",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, body, auth }) => {
        const { projectId } = projectArtifactsParamsSchema.parse(params);
        const { input } = deleteProjectArtifactsBodySchema.parse(body);
        return Result.unwrap(
          await deleteProjectArtifacts(projectId, input, {
            userAuthz: auth.userAuthz,
            artifactRepo: appContext.artifactRepo,
            objectStore: appContext.objectStore,
            orgRepo: appContext.orgRepo,
            timeProvider: appContext.timeProvider,
            domainEventDispatcher: appContext.domainEventDispatcher,
            logger: appContext.logger,
          }),
        );
      },
    )
    .delete(
      "/projects/:projectId/artifacts/:artifactId",
      {
        params: projectArtifactItemParamsSchema,
        response: responseSchemas({
          200: z.number(),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "deleteProjectArtifact",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, artifactId } =
          projectArtifactItemParamsSchema.parse(params);
        return Result.unwrap(
          await deleteProjectArtifact(projectId, artifactId, {
            userAuthz: auth.userAuthz,
            artifactRepo: appContext.artifactRepo,
            objectStore: appContext.objectStore,
            orgRepo: appContext.orgRepo,
            timeProvider: appContext.timeProvider,
            domainEventDispatcher: appContext.domainEventDispatcher,
            logger: appContext.logger,
          }),
        );
      },
    );
