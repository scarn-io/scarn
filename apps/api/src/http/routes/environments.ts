import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import {
  environmentContentSchema,
  environmentNameSchema,
} from "@scarn/core/common/contracts/environment";
import { listEnvironments } from "@scarn/core/pipeline-definitions/environment/application/list-environments";
import { getEnvironment } from "@scarn/core/pipeline-definitions/environment/application/get-environment";
import { publishEnvironmentVersion } from "@scarn/core/pipeline-definitions/environment/application/publish-environment-version";
import { deleteEnvironment } from "@scarn/core/pipeline-definitions/environment/application/delete-environment";
import {
  deleteEnvironmentResultSchema,
  environmentSchema,
  environmentWithVersionSchema,
  publishEnvironmentVersionResultSchema,
} from "@scarn/core/pipeline-definitions/environment/contracts/environment-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const environmentParamsSchema = projectParamsSchema.extend({
  name: environmentNameSchema,
});

const getEnvironmentQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

const publishEnvironmentVersionBodySchema = z.object({
  content: environmentContentSchema,
});

/**
 * A project's named environments, each a series of immutable numbered
 * versions. Reads need `executions:read`, writes `executions:write`.
 */
export const createEnvironmentRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/environments",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: z.array(environmentSchema),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "listEnvironments", tags: ["Environments"] },
      },
      async ({ params, auth }) =>
        await listEnvironments(projectParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          environmentRepo: appContext.environmentRepo,
          usernameReader: appContext.usernameReader,
        }),
    )
    .get(
      "/projects/:projectId/environments/:name",
      {
        params: environmentParamsSchema,
        query: getEnvironmentQuerySchema,
        response: responseSchemas({
          200: environmentWithVersionSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getEnvironment", tags: ["Environments"] },
      },
      async ({ params, query, auth }) =>
        Result.unwrap(
          await getEnvironment(
            {
              ...environmentParamsSchema.parse(params),
              ...getEnvironmentQuerySchema.parse(query),
            },
            {
              userAuthz: auth.userAuthz,
              environmentRepo: appContext.environmentRepo,
              usernameReader: appContext.usernameReader,
            },
          ),
        ),
    )
    .put(
      "/projects/:projectId/environments/:name",
      {
        params: environmentParamsSchema,
        body: publishEnvironmentVersionBodySchema,
        response: responseSchemas({
          200: publishEnvironmentVersionResultSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "publishEnvironmentVersion",
          tags: ["Environments"],
        },
      },
      async ({ params, body, auth }) =>
        await publishEnvironmentVersion(
          {
            ...environmentParamsSchema.parse(params),
            content: body.content,
          },
          {
            userAuthz: auth.userAuthz,
            environmentRepo: appContext.environmentRepo,
            usernameReader: appContext.usernameReader,
            timeProvider: appContext.timeProvider,
          },
        ),
    )
    .delete(
      "/projects/:projectId/environments/:name",
      {
        params: environmentParamsSchema,
        response: responseSchemas({
          200: deleteEnvironmentResultSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "deleteEnvironment", tags: ["Environments"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await deleteEnvironment(environmentParamsSchema.parse(params), {
            userAuthz: auth.userAuthz,
            environmentRepo: appContext.environmentRepo,
            timeProvider: appContext.timeProvider,
          }),
        ),
    );
