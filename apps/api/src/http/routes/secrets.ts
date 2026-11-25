import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { createSecret } from "@scarn/core/secrets/secret/application/create-secret";
import { listMySecrets } from "@scarn/core/secrets/secret/application/list-my-secrets";
import { renameSecret } from "@scarn/core/secrets/secret/application/rename-secret";
import { deleteSecret } from "@scarn/core/secrets/secret/application/delete-secret";
import {
  createSecretSchema,
  deleteSecretResponseSchema,
  listSecretsQuerySchema,
  renameSecretSchema,
  secretSchema,
} from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const secretParamsSchema = z.object({
  secretId: uuidV7Schema,
});

/**
 * The caller's own secrets ("API keys" in the UI). The `/me` prefix fixes the
 * owner as the session user. No route ever returns a secret's value.
 */
export const createSecretRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/me/secrets",
      {
        query: listSecretsQuerySchema,
        response: responseSchemas({
          200: z.array(secretSchema),
          ...stdErrors,
        }),
        detail: { operationId: "listMySecrets", tags: ["Secrets"] },
      },
      async ({ query, auth }) =>
        await listMySecrets(listSecretsQuerySchema.parse(query), {
          userAuthz: auth.userAuthz,
          secretRepo: appContext.secretRepo,
          timeProvider: appContext.timeProvider,
        }),
    )
    .post(
      "/me/secrets",
      {
        body: createSecretSchema,
        response: responseSchemas({
          201: secretSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "createMySecret", tags: ["Secrets"] },
      },
      async ({ body, auth, set }) => {
        const secret = await createSecret(createSecretSchema.parse(body), {
          userAuthz: auth.userAuthz,
          secretRepo: appContext.secretRepo,
          secretCipher: appContext.secretCipher,
          timeProvider: appContext.timeProvider,
        });
        set.status = 201;
        return secret;
      },
    )
    .patch(
      "/me/secrets/:secretId",
      {
        params: secretParamsSchema,
        body: renameSecretSchema,
        response: responseSchemas({
          200: secretSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "renameMySecret", tags: ["Secrets"] },
      },
      async ({ params, body, auth }) => {
        const { secretId } = secretParamsSchema.parse(params);
        return await renameSecret(
          { secretId, rename: renameSecretSchema.parse(body) },
          {
            userAuthz: auth.userAuthz,
            secretRepo: appContext.secretRepo,
            timeProvider: appContext.timeProvider,
          },
        );
      },
    )
    .delete(
      "/me/secrets/:secretId",
      {
        params: secretParamsSchema,
        response: responseSchemas({
          200: deleteSecretResponseSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "deleteMySecret", tags: ["Secrets"] },
      },
      async ({ params, auth }) => {
        const { secretId } = secretParamsSchema.parse(params);
        return await deleteSecret(
          { secretId },
          {
            userAuthz: auth.userAuthz,
            secretRepo: appContext.secretRepo,
          },
        );
      },
    );
