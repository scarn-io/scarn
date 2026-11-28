import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createArtifactUploadUrl } from "@scarn/core/tasks/task-artifact/application/create-artifact-upload-url";
import { recordTaskArtifact } from "@scarn/core/tasks/task-artifact/application/record-task-artifact";
import { listTaskArtifacts } from "@scarn/core/tasks/task-artifact/application/list-task-artifacts";
import { getArtifactDownloadUrl } from "@scarn/core/tasks/task-artifact/application/get-artifact-download-url";
import { createArtifactBundle } from "@scarn/core/tasks/task-artifact/application/create-artifact-bundle";
import { finalizeArtifactBundle } from "@scarn/core/tasks/task-artifact/application/finalize-artifact-bundle";
import { listTaskArtifactBundles } from "@scarn/core/tasks/task-artifact/application/list-task-artifact-bundles";
import { getArtifactBundle } from "@scarn/core/tasks/task-artifact/application/get-artifact-bundle";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import {
  artifactBundleSchema,
  artifactDownloadUrlSchema,
  artifactSchema,
  artifactUploadUrlSchema,
  createArtifactBundleInputSchema,
  createArtifactUploadUrlInputSchema,
  finalizeArtifactBundleInputSchema,
  listArtifactBundlesResponseSchema,
  recordArtifactInputSchema,
} from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const artifactDownloadUrlParamsSchema = z.object({
  taskRunId: uuidV7Schema,
  artifactId: uuidV7Schema,
});

const artifactBundleParamsSchema = z.object({
  taskRunId: uuidV7Schema,
  bundleId: uuidV7Schema,
});

// The write side: minting an upload URL and recording the resulting artifact.
// Always requires a real session — see `createTaskRunArtifactReadRoutes`
// below for the GET counterpart that also serves non-members of a public
// project.
const createTaskRunArtifactWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/:taskRunId/artifact-upload-url",
      {
        params: taskRunIdParamsSchema,
        body: createArtifactUploadUrlInputSchema,
        response: responseSchemas({
          200: artifactUploadUrlSchema,
          402: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "createArtifactUploadUrl", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await createArtifactUploadUrl(
            taskRunIdParamsSchema.parse(params).taskRunId,
            createArtifactUploadUrlInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactBundleRepo: appContext.artifactBundleRepo,
              artifactBundleLimits: appContext.artifactBundleLimits,
              objectStore: appContext.objectStore,
              objectStorageBucket: appContext.objectStorageBucket,
              timeProvider: appContext.timeProvider,
              orgRepo: appContext.orgRepo,
              usageMeterRepo: appContext.usageMeterRepo,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/artifacts",
      {
        params: taskRunIdParamsSchema,
        body: recordArtifactInputSchema,
        response: responseSchemas({
          200: artifactSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "recordTaskArtifact", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await recordTaskArtifact(
            taskRunIdParamsSchema.parse(params).taskRunId,
            recordArtifactInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactRepo: appContext.artifactRepo,
              artifactBundleRepo: appContext.artifactBundleRepo,
              artifactBundleLimits: appContext.artifactBundleLimits,
              objectStorageBucket: appContext.objectStorageBucket,
              orgRepo: appContext.orgRepo,
              timeProvider: appContext.timeProvider,
              domainEventDispatcher: appContext.domainEventDispatcher,
              analytics: appContext.analytics,
              logger: appContext.logger,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/artifact-bundles",
      {
        params: taskRunIdParamsSchema,
        body: createArtifactBundleInputSchema,
        response: responseSchemas({
          200: artifactBundleSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "createArtifactBundle", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await createArtifactBundle(
            taskRunIdParamsSchema.parse(params).taskRunId,
            createArtifactBundleInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactBundleRepo: appContext.artifactBundleRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/artifact-bundles/:bundleId/finalize",
      {
        params: artifactBundleParamsSchema,
        body: finalizeArtifactBundleInputSchema,
        response: responseSchemas({
          200: artifactBundleSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "finalizeArtifactBundle", tags: ["TaskRuns"] },
      },
      async ({ params, body, auth }) => {
        const { taskRunId, bundleId } =
          artifactBundleParamsSchema.parse(params);
        return Result.unwrap(
          await finalizeArtifactBundle(
            taskRunId,
            bundleId,
            finalizeArtifactBundleInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactBundleRepo: appContext.artifactBundleRepo,
              artifactBundleLimits: appContext.artifactBundleLimits,
              artifactShareRepo: appContext.artifactShareRepo,
              artifactSharingConfig: appContext.artifactSharingConfig,
              orgRepo: appContext.orgRepo,
              timeProvider: appContext.timeProvider,
              domainEventDispatcher: appContext.domainEventDispatcher,
              logger: appContext.logger,
            },
          ),
        );
      },
    );

// The read side: listing artifacts and minting a download URL. Serves
// non-members of a public project — including fully anonymous callers — via
// `createOptionallyAuthenticated`. `getArtifactDownloadUrl` internally checks
// `ProjectPermissionGrant.isPublicNonMemberGrant` to keep these reads out of
// the owning org's usage-quota accounting (see issue #149).
const createTaskRunArtifactReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/task-runs/:taskRunId/artifacts",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: z.array(artifactSchema),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "listTaskArtifacts", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listTaskArtifacts(
            taskRunIdParamsSchema.parse(params).taskRunId,
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactRepo: appContext.artifactRepo,
            },
          ),
        ),
    )
    .get(
      "/task-runs/:taskRunId/artifact-bundles",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: listArtifactBundlesResponseSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "listArtifactBundles", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listTaskArtifactBundles(
            taskRunIdParamsSchema.parse(params).taskRunId,
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              artifactBundleRepo: appContext.artifactBundleRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .get(
      "/task-runs/:taskRunId/artifact-bundles/:bundleId",
      {
        params: artifactBundleParamsSchema,
        response: responseSchemas({
          200: artifactBundleSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getArtifactBundle", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) => {
        const { taskRunId, bundleId } =
          artifactBundleParamsSchema.parse(params);
        return Result.unwrap(
          await getArtifactBundle(taskRunId, bundleId, {
            userAuthz: auth.userAuthz,
            taskRunRepo: appContext.taskRunRepo,
            artifactBundleRepo: appContext.artifactBundleRepo,
            timeProvider: appContext.timeProvider,
          }),
        );
      },
    )
    .get(
      "/task-runs/:taskRunId/artifacts/:artifactId/download-url",
      {
        params: artifactDownloadUrlParamsSchema,
        response: responseSchemas({
          200: artifactDownloadUrlSchema,
          402: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          410: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getArtifactDownloadUrl", tags: ["TaskRuns"] },
      },
      async ({ params, auth }) => {
        const { taskRunId, artifactId } =
          artifactDownloadUrlParamsSchema.parse(params);
        return Result.unwrap(
          await getArtifactDownloadUrl(taskRunId, artifactId, {
            userAuthz: auth.userAuthz,
            taskRunRepo: appContext.taskRunRepo,
            artifactRepo: appContext.artifactRepo,
            objectStore: appContext.objectStore,
            timeProvider: appContext.timeProvider,
            orgRepo: appContext.orgRepo,
            usageMeterRepo: appContext.usageMeterRepo,
            domainEventDispatcher: appContext.domainEventDispatcher,
            logger: appContext.logger,
          }),
        );
      },
    );

export const createTaskRunArtifactRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createTaskRunArtifactWriteRoutes(appContext))
    .use(createTaskRunArtifactReadRoutes(appContext));
