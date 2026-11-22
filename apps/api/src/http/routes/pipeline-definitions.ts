import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createPipelineGraph as createPipelineDefinition } from "@scarn/core/pipeline-definitions/pipeline-graph/application/create-pipeline-graph";
import { archivePipelineGraph as archivePipelineDefinition } from "@scarn/core/pipeline-definitions/pipeline-graph/application/archive-pipeline-graph";
import { unarchivePipelineGraph as unarchivePipelineDefinition } from "@scarn/core/pipeline-definitions/pipeline-graph/application/unarchive-pipeline-graph";
import { publishPipelineVersion } from "@scarn/core/pipeline-definitions/pipeline-graph/application/publish-pipeline-graph-version";
import { activatePipelineGraphVersion } from "@scarn/core/pipeline-definitions/pipeline-graph/application/activate-pipeline-graph-version";
import {
  createPipelineDefinitionInputSchema,
  getPipelineDefinitionInputSchema,
  pipelineDefinitionSchema,
  publishPipelineVersionInputSchema,
  publishPipelineVersionResultSchema,
} from "@scarn/core/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const pipelineDefinitionIdParamsSchema = z.object({
  pipelineDefinitionId: getPipelineDefinitionInputSchema,
});
const pipelineDefinitionVersionParamsSchema =
  pipelineDefinitionIdParamsSchema.extend({
    version: z.coerce.number().int().positive(),
  });
const publishPipelineVersionBodySchema = publishPipelineVersionInputSchema.omit(
  { pipelineDefinitionId: true },
);

// The write side of `/pipeline-definitions`: create/publish/activate/archive/unarchive. Always requires a real session; every use
// case here asserts real membership regardless of the project's visibility.
// The two listing/detail reads live in `pipeline-definition-reads.ts`
// on `createOptionallyAuthenticated` (see issue #150).
export const createPipelineDefinitionRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/pipeline-definitions",
      {
        body: createPipelineDefinitionInputSchema,
        response: responseSchemas({
          200: pipelineDefinitionSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "createPipelineDefinition",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ body, auth }) =>
        Result.unwrap(
          await createPipelineDefinition(
            createPipelineDefinitionInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              pipelineGraphRepo: appContext.pipelineGraphRepo,
              pipelineGraphVersionRepo: appContext.pipelineGraphVersionRepo,
              stepDefinitionRepo: appContext.stepDefinitionRepo,
              timeProvider: appContext.timeProvider,
              analytics: appContext.analytics,
              via: "web",
            },
          ),
        ),
    )
    .post(
      "/pipeline-definitions/:pipelineDefinitionId/versions",
      {
        params: pipelineDefinitionIdParamsSchema,
        body: publishPipelineVersionBodySchema,
        response: responseSchemas({
          200: publishPipelineVersionResultSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "publishPipelineDefinitionVersion",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await publishPipelineVersion(
            {
              pipelineDefinitionId:
                pipelineDefinitionIdParamsSchema.parse(params)
                  .pipelineDefinitionId,
              document: publishPipelineVersionBodySchema.parse(body).document,
            },
            {
              userAuthz: auth.userAuthz,
              pipelineGraphRepo: appContext.pipelineGraphRepo,
              pipelineGraphVersionRepo: appContext.pipelineGraphVersionRepo,
              stepDefinitionRepo: appContext.stepDefinitionRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .put(
      "/pipeline-definitions/:pipelineDefinitionId/versions/:version/activate",
      {
        params: pipelineDefinitionVersionParamsSchema,
        response: responseSchemas({
          200: pipelineDefinitionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "activatePipelineDefinitionVersion",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await activatePipelineGraphVersion(
            pipelineDefinitionVersionParamsSchema.parse(params),
            {
              userAuthz: auth.userAuthz,
              pipelineGraphRepo: appContext.pipelineGraphRepo,
              pipelineGraphVersionRepo: appContext.pipelineGraphVersionRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .put(
      "/pipeline-definitions/:pipelineDefinitionId/archive",
      {
        params: pipelineDefinitionIdParamsSchema,
        response: responseSchemas({
          200: pipelineDefinitionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "archivePipelineDefinition",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await archivePipelineDefinition(
            pipelineDefinitionIdParamsSchema.parse(params).pipelineDefinitionId,
            {
              userAuthz: auth.userAuthz,
              pipelineGraphRepo: appContext.pipelineGraphRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .put(
      "/pipeline-definitions/:pipelineDefinitionId/unarchive",
      {
        params: pipelineDefinitionIdParamsSchema,
        response: responseSchemas({
          200: pipelineDefinitionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "unarchivePipelineDefinition",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await unarchivePipelineDefinition(
            pipelineDefinitionIdParamsSchema.parse(params).pipelineDefinitionId,
            {
              userAuthz: auth.userAuthz,
              pipelineGraphRepo: appContext.pipelineGraphRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );
