import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { createProjectSecret } from "@scarn/core/secrets/secret/application/create-project-secret";
import { listProjectSecrets } from "@scarn/core/secrets/secret/application/list-project-secrets";
import { updateProjectSecret } from "@scarn/core/secrets/secret/application/update-project-secret";
import { deleteProjectSecret } from "@scarn/core/secrets/secret/application/delete-project-secret";
import {
  createProjectSecretSchema,
  deleteProjectSecretResponseSchema,
  projectSecretSchema,
  updateProjectSecretSchema,
} from "@scarn/core/secrets/secret/contracts/project-secret-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const projectSecretParamsSchema = z.object({
  projectId: uuidV7Schema,
  secretId: uuidV7Schema,
});

/**
 * A project's secrets: named values its environments reference by name.
 * Reads need `secrets:read`, writes `secrets:write`. No route ever returns a
 * secret's value.
 */
export const createProjectSecretRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/secrets",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: z.array(projectSecretSchema),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "listProjectSecrets", tags: ["ProjectSecrets"] },
      },
      async ({ params, auth }) =>
        await listProjectSecrets(projectParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          secretRepo: appContext.secretRepo,
          usernameReader: appContext.usernameReader,
        }),
    )
    .post(
      "/projects/:projectId/secrets",
      {
        params: projectParamsSchema,
        body: createProjectSecretSchema,
        response: responseSchemas({
          201: projectSecretSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "createProjectSecret",
          tags: ["ProjectSecrets"],
        },
      },
      async ({ params, body, auth, set }) => {
        const { projectId } = projectParamsSchema.parse(params);
        const secret = await createProjectSecret(
          { projectId, secret: createProjectSecretSchema.parse(body) },
          {
            userAuthz: auth.userAuthz,
            secretRepo: appContext.secretRepo,
            secretCipher: appContext.secretCipher,
            timeProvider: appContext.timeProvider,
            usernameReader: appContext.usernameReader,
          },
        );
        set.status = 201;
        return secret;
      },
    )
    .patch(
      "/projects/:projectId/secrets/:secretId",
      {
        params: projectSecretParamsSchema,
        body: updateProjectSecretSchema,
        response: responseSchemas({
          200: projectSecretSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "updateProjectSecret",
          tags: ["ProjectSecrets"],
        },
      },
      async ({ params, body, auth }) =>
        await updateProjectSecret(
          {
            ...projectSecretParamsSchema.parse(params),
            update: updateProjectSecretSchema.parse(body),
          },
          {
            userAuthz: auth.userAuthz,
            secretRepo: appContext.secretRepo,
            secretCipher: appContext.secretCipher,
            timeProvider: appContext.timeProvider,
            usernameReader: appContext.usernameReader,
          },
        ),
    )
    .delete(
      "/projects/:projectId/secrets/:secretId",
      {
        params: projectSecretParamsSchema,
        response: responseSchemas({
          200: deleteProjectSecretResponseSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "deleteProjectSecret",
          tags: ["ProjectSecrets"],
        },
      },
      async ({ params, auth }) =>
        await deleteProjectSecret(projectSecretParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          secretRepo: appContext.secretRepo,
        }),
    );
