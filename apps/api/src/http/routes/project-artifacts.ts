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
import { getProjectArtifactBundle } from "@scarn/core/tasks/task-artifact/application/get-project-artifact-bundle";
import {
  deleteProjectArtifactsInputSchema,
  listProjectArtifactsResponseSchema,
  projectArtifactBundleDetailSchema,
  projectArtifactDetailSchema,
} from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
import { shareArtifactBundle } from "@scarn/core/tasks/artifact-share/application/share-artifact-bundle";
import { revokeArtifactShare } from "@scarn/core/tasks/artifact-share/application/revoke-artifact-share";
import { getArtifactShare } from "@scarn/core/tasks/artifact-share/application/get-artifact-share";
import { createArtifactPreview } from "@scarn/core/tasks/artifact-share/application/create-artifact-preview";
import { listProjectArtifactShares } from "@scarn/core/tasks/artifact-share/application/list-project-artifact-shares";
import {
  artifactPreviewSchema,
  artifactShareSchema,
  listProjectArtifactSharesResponseSchema,
} from "@scarn/core/tasks/artifact-share/contracts/artifact-share-contracts";
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
const projectBundleParamsSchema = z.object({
  projectId: uuidV7Schema,
  bundleId: uuidV7Schema,
});

const shareDeps = (appContext: AppContext) => ({
  artifactBundleRepo: appContext.artifactBundleRepo,
  artifactShareRepo: appContext.artifactShareRepo,
  artifactSharingConfig: appContext.artifactSharingConfig,
  taskRunRepo: appContext.taskRunRepo,
  timeProvider: appContext.timeProvider,
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
          artifactBundleRepo: appContext.artifactBundleRepo,
          timeProvider: appContext.timeProvider,
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
    )
    .get(
      "/projects/:projectId/artifact-bundles/:bundleId",
      {
        params: projectBundleParamsSchema,
        response: responseSchemas({
          200: projectArtifactBundleDetailSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getProjectArtifactBundle",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, bundleId } = projectBundleParamsSchema.parse(params);
        return Result.unwrap(
          await getProjectArtifactBundle(projectId, bundleId, {
            userAuthz: auth.userAuthz,
            artifactBundleRepo: appContext.artifactBundleRepo,
            timeProvider: appContext.timeProvider,
          }),
        );
      },
    )
    .get(
      "/projects/:projectId/artifact-shares",
      {
        params: projectArtifactsParamsSchema,
        response: responseSchemas({
          200: listProjectArtifactSharesResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listProjectArtifactShares",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId } = projectArtifactsParamsSchema.parse(params);
        return await listProjectArtifactShares(projectId, {
          userAuthz: auth.userAuthz,
          artifactBundleRepo: appContext.artifactBundleRepo,
          artifactShareRepo: appContext.artifactShareRepo,
          artifactSharingConfig: appContext.artifactSharingConfig,
          timeProvider: appContext.timeProvider,
        });
      },
    )
    .post(
      "/projects/:projectId/artifact-bundles/:bundleId/share",
      {
        params: projectBundleParamsSchema,
        response: responseSchemas({
          200: artifactShareSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "shareArtifactBundle",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, bundleId } = projectBundleParamsSchema.parse(params);
        return Result.unwrap(
          await shareArtifactBundle(projectId, bundleId, {
            userAuthz: auth.userAuthz,
            ...shareDeps(appContext),
          }),
        );
      },
    )
    .delete(
      "/projects/:projectId/artifact-bundles/:bundleId/share",
      {
        params: projectBundleParamsSchema,
        response: responseSchemas({
          200: artifactShareSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "revokeArtifactShare",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, bundleId } = projectBundleParamsSchema.parse(params);
        return Result.unwrap(
          await revokeArtifactShare(projectId, bundleId, {
            userAuthz: auth.userAuthz,
            ...shareDeps(appContext),
          }),
        );
      },
    )
    .get(
      "/projects/:projectId/artifact-bundles/:bundleId/share",
      {
        params: projectBundleParamsSchema,
        response: responseSchemas({
          200: artifactShareSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getArtifactShare",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, bundleId } = projectBundleParamsSchema.parse(params);
        return Result.unwrap(
          await getArtifactShare(projectId, bundleId, {
            userAuthz: auth.userAuthz,
            ...shareDeps(appContext),
          }),
        );
      },
    )
    .post(
      "/projects/:projectId/artifact-bundles/:bundleId/preview",
      {
        params: projectBundleParamsSchema,
        response: responseSchemas({
          200: artifactPreviewSchema,
          402: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "createArtifactBundlePreview",
          tags: ["ProjectArtifacts"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, bundleId } = projectBundleParamsSchema.parse(params);
        return Result.unwrap(
          await createArtifactPreview(projectId, bundleId, {
            userAuthz: auth.userAuthz,
            artifactBundleRepo: appContext.artifactBundleRepo,
            artifactSharingConfig: appContext.artifactSharingConfig,
            timeProvider: appContext.timeProvider,
            orgRepo: appContext.orgRepo,
            usageMeterRepo: appContext.usageMeterRepo,
            domainEventDispatcher: appContext.domainEventDispatcher,
            logger: appContext.logger,
          }),
        );
      },
    );
