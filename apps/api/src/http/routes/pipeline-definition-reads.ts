import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { getPipelineGraph as getPipelineDefinition } from "@scarn/core/pipeline-definitions/pipeline-graph/application/get-pipeline-graph";
import { listPipelineGraphsByProjectId as listPipelineDefinitionsByProjectId } from "@scarn/core/pipeline-definitions/pipeline-graph/application/list-pipeline-graphs";
import {
  getPipelineGraphVersion as getPipelineDefinitionVersion,
  listPipelineGraphVersions as listPipelineDefinitionVersions,
} from "@scarn/core/pipeline-definitions/pipeline-graph/application/get-pipeline-graph-version";
import {
  getPipelineDefinitionInputSchema,
  pipelineDefinitionSchema,
  pipelineVersionSchema,
  pipelineVersionSummarySchema,
  listPipelineDefinitionsByProjectIdInputSchema,
} from "@scarn/core/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createOptionallyAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const pipelineDefinitionIdParamsSchema = z.object({
  pipelineDefinitionId: getPipelineDefinitionInputSchema,
});
const pipelineDefinitionVersionParamsSchema =
  pipelineDefinitionIdParamsSchema.extend({
    version: z.coerce.number().int().positive(),
  });
const pipelineDefinitionProjectParamsSchema = z.object({
  projectId: listPipelineDefinitionsByProjectIdInputSchema,
});
const listPipelineDefinitionsQuerySchema = z.object({
  includeArchived: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((v) => v === "true"),
    ])
    .optional(),
});

/**
 * The read side of `/pipeline-definitions`.
 *
 * Split out of `pipeline-definitions.ts` (which keeps every write:
 * create/upsert/archive/unarchive and all step-definition mutations) so these
 * two listing/detail reads can run on `createOptionallyAuthenticated` instead
 * of `createAuthenticated`.
 *
 * Rendering a public project's work items and executions "exactly as a member
 * would" (issue #150) requires pipeline definition names — the work items
 * list, the work item executions drawer, the executions list, and the
 * execution detail page all resolve a definition id to a name/step list. Both
 * use cases here already call `requireProjectPermission` with
 * `executions:read`, which `assertProjectPermission` grants to any actor on a
 * `visibility: "public"` project (issue #149) — this seam only lets that
 * fallback apply to a fully anonymous caller too. A missing/non-member
 * session on a private project is denied exactly as before (401/403).
 */
export const createPipelineDefinitionReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/pipeline-definitions/:pipelineDefinitionId",
      {
        params: pipelineDefinitionIdParamsSchema,
        response: responseSchemas({
          200: pipelineDefinitionSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getPipelineDefinition",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getPipelineDefinition(
            pipelineDefinitionIdParamsSchema.parse(params).pipelineDefinitionId,
            {
              userAuthz: auth.userAuthz,
              pipelineGraphRepo: appContext.pipelineGraphRepo,
            },
          ),
        ),
    )
    .get(
      "/pipeline-definitions/:pipelineDefinitionId/versions",
      {
        params: pipelineDefinitionIdParamsSchema,
        response: responseSchemas({
          200: z.array(pipelineVersionSummarySchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listPipelineDefinitionVersions",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listPipelineDefinitionVersions(
            pipelineDefinitionIdParamsSchema.parse(params).pipelineDefinitionId,
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .get(
      "/pipeline-definitions/:pipelineDefinitionId/versions/:version",
      {
        params: pipelineDefinitionVersionParamsSchema,
        response: responseSchemas({
          200: pipelineVersionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getPipelineDefinitionVersion",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getPipelineDefinitionVersion(
            pipelineDefinitionVersionParamsSchema.parse(params),
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .get(
      "/projects/:projectId/pipeline-definitions",
      {
        params: pipelineDefinitionProjectParamsSchema,
        query: listPipelineDefinitionsQuerySchema,
        response: responseSchemas({
          200: z.array(pipelineDefinitionSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listPipelineDefinitions",
          tags: ["PipelineDefinitions"],
        },
      },
      async ({ params, query, auth }) => {
        const { projectId } =
          pipelineDefinitionProjectParamsSchema.parse(params);
        const parsedQuery = listPipelineDefinitionsQuerySchema.parse(query);
        return await listPipelineDefinitionsByProjectId(projectId, {
          userAuthz: auth.userAuthz,
          pipelineGraphRepo: appContext.pipelineGraphRepo,
          includeArchived: parsedQuery.includeArchived,
        });
      },
    );
