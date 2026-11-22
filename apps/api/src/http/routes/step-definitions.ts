import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createStepDefinition } from "@scarn/core/pipeline-definitions/step-definition/application/create-step-definition";
import { getStepDefinition } from "@scarn/core/pipeline-definitions/step-definition/application/get-step-definition";
import { listStepDefinitionsByProjectId } from "@scarn/core/pipeline-definitions/step-definition/application/list-step-definitions";
import { upsertStepDefinition } from "@scarn/core/pipeline-definitions/step-definition/application/upsert-step-definition";
import { archiveStepDefinition } from "@scarn/core/pipeline-definitions/step-definition/application/archive-step-definition";
import {
  createStepDefinitionInputSchema,
  getStepDefinitionInputSchema,
  listStepDefinitionsByProjectIdInputSchema,
  stepDefinitionSchema,
  upsertStepDefinitionInputSchema,
} from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const stepDefinitionIdParamsSchema = z.object({
  stepDefinitionId: getStepDefinitionInputSchema,
});
const listStepDefinitionsQuerySchema = z.object({
  projectId: listStepDefinitionsByProjectIdInputSchema,
});

export const createStepDefinitionRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/step-definitions",
      {
        body: createStepDefinitionInputSchema,
        response: responseSchemas({
          200: stepDefinitionSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "createStepDefinition",
          tags: ["StepDefinitions"],
        },
      },
      async ({ body, auth }) => {
        const input = createStepDefinitionInputSchema.parse(body);
        return await createStepDefinition(input, {
          userAuthz: auth.userAuthz,
          stepDefinitionRepo: appContext.stepDefinitionRepo,
          taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
          environmentRepo: appContext.environmentRepo,
          timeProvider: appContext.timeProvider,
        });
      },
    )
    .get(
      "/step-definitions/:stepDefinitionId",
      {
        params: stepDefinitionIdParamsSchema,
        response: responseSchemas({
          200: stepDefinitionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "getStepDefinition", tags: ["StepDefinitions"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getStepDefinition(
            stepDefinitionIdParamsSchema.parse(params).stepDefinitionId,
            {
              userAuthz: auth.userAuthz,
              stepDefinitionRepo: appContext.stepDefinitionRepo,
              taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
            },
          ),
        ),
    )
    .get(
      "/step-definitions",
      {
        query: listStepDefinitionsQuerySchema,
        response: responseSchemas({
          200: z.array(stepDefinitionSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listStepDefinitions",
          tags: ["StepDefinitions"],
        },
      },
      async ({ query, auth }) =>
        await listStepDefinitionsByProjectId(
          listStepDefinitionsQuerySchema.parse(query).projectId,
          {
            userAuthz: auth.userAuthz,
            stepDefinitionRepo: appContext.stepDefinitionRepo,
            taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
          },
        ),
    )
    .put(
      "/step-definitions",
      {
        body: upsertStepDefinitionInputSchema,
        response: responseSchemas({
          200: stepDefinitionSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "upsertStepDefinition",
          tags: ["StepDefinitions"],
        },
      },
      async ({ body, auth }) =>
        await upsertStepDefinition(
          upsertStepDefinitionInputSchema.parse(body),
          {
            userAuthz: auth.userAuthz,
            stepDefinitionRepo: appContext.stepDefinitionRepo,
            taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
            environmentRepo: appContext.environmentRepo,
            timeProvider: appContext.timeProvider,
          },
        ),
    )
    .put(
      "/step-definitions/:stepDefinitionId/archive",
      {
        params: stepDefinitionIdParamsSchema,
        response: responseSchemas({
          200: stepDefinitionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "archiveStepDefinition",
          tags: ["StepDefinitions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await archiveStepDefinition(
            stepDefinitionIdParamsSchema.parse(params).stepDefinitionId,
            {
              userAuthz: auth.userAuthz,
              stepDefinitionRepo: appContext.stepDefinitionRepo,
              taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );
