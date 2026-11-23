import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { workItemIdSchema } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { publishAutomation } from "@scarn/core/pipeline-definitions/automation/application/publish-automation";
import {
  listAutomations,
  setAutomationEnabled,
} from "@scarn/core/pipeline-definitions/automation/application/manage-automations";
import {
  attachWorkItemAutomation,
  detachWorkItemAutomation,
  listWorkItemAutomations,
} from "@scarn/core/pipeline-definitions/automation/application/work-item-automations";
import { runScheduleNow } from "@scarn/core/pipeline-definitions/automation/application/run-schedule-now";
import {
  automationListItemSchema,
  automationSchema,
  publishAutomationResultSchema,
  runAutomationScheduleResultSchema,
  workItemAutomationSchema,
} from "@scarn/core/pipeline-definitions/automation/contracts/automation-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { responseSchemas } from "../response-schemas";

const keySchema = z.string().trim().min(1);
const projectParamsSchema = z.object({ projectId: uuidV7Schema });
const automationParamsSchema = projectParamsSchema.extend({ key: keySchema });
const scheduleParamsSchema = automationParamsSchema.extend({
  ruleKey: keySchema,
});
const workItemParamsSchema = z.object({ workItemId: workItemIdSchema });
const workItemAutomationParamsSchema = workItemParamsSchema.extend({
  key: keySchema,
});
const publishAutomationBodySchema = z.object({ document: anyJsonObjectSchema });

const errorResponses = {
  400: apiErrorResponseSchema,
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  404: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
};

const tags = ["Automations"];

/**
 * Automations: publish, list and enable/disable a project's automations,
 * run a schedule now, and attach work-item automations to work items. The two lists run on
 * `createOptionallyAuthenticated`, like the pipeline definition reads, so a
 * public project's readers can see them.
 */
export const createAutomationRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      new Elysia()
        .use(
          createOptionallyAuthenticated(
            appContext.createUserAuthorizationService,
          ),
        )
        .get(
          "/projects/:projectId/automations",
          {
            params: projectParamsSchema,
            response: responseSchemas({
              200: z.array(automationListItemSchema),
              ...errorResponses,
            }),
            detail: { operationId: "listAutomations", tags },
          },
          async ({ params, auth }) =>
            await listAutomations(projectParamsSchema.parse(params).projectId, {
              userAuthz: auth.userAuthz,
              automationRepo: appContext.automationRepo,
              automationScheduleRepo: appContext.automationScheduleRepo,
            }),
        )
        .get(
          "/work-items/:workItemId/automations",
          {
            params: workItemParamsSchema,
            response: responseSchemas({
              200: z.array(workItemAutomationSchema),
              ...errorResponses,
            }),
            detail: { operationId: "listWorkItemAutomations", tags },
          },
          async ({ params, auth }) =>
            Result.unwrap(
              await listWorkItemAutomations(
                workItemParamsSchema.parse(params).workItemId,
                { ...appContext, userAuthz: auth.userAuthz },
              ),
            ),
        ),
    )
    .use(
      new Elysia()
        .use(createAuthenticated(appContext.createUserAuthorizationService))
        .put(
          "/projects/:projectId/automations/:key",
          {
            params: automationParamsSchema,
            body: publishAutomationBodySchema,
            response: responseSchemas({
              200: publishAutomationResultSchema,
              ...errorResponses,
            }),
            detail: { operationId: "publishAutomation", tags },
          },
          async ({ params, body, auth }) =>
            Result.unwrap(
              await publishAutomation(
                {
                  ...automationParamsSchema.parse(params),
                  document: publishAutomationBodySchema.parse(body).document,
                },
                {
                  userAuthz: auth.userAuthz,
                  automationRepo: appContext.automationRepo,
                  automationScheduleRepo: appContext.automationScheduleRepo,
                  stepDefinitionRepo: appContext.stepDefinitionRepo,
                  pipelineGraphRepo: appContext.pipelineGraphRepo,
                  timeProvider: appContext.timeProvider,
                },
              ),
            ),
        )
        .post(
          "/projects/:projectId/automations/:key/enable",
          {
            params: automationParamsSchema,
            response: responseSchemas({
              200: automationSchema,
              ...errorResponses,
            }),
            detail: { operationId: "enableAutomation", tags },
          },
          async ({ params, auth }) =>
            Result.unwrap(
              await setAutomationEnabled(
                { ...automationParamsSchema.parse(params), enabled: true },
                { ...appContext, userAuthz: auth.userAuthz },
              ),
            ),
        )
        .post(
          "/projects/:projectId/automations/:key/disable",
          {
            params: automationParamsSchema,
            response: responseSchemas({
              200: automationSchema,
              ...errorResponses,
            }),
            detail: { operationId: "disableAutomation", tags },
          },
          async ({ params, auth }) =>
            Result.unwrap(
              await setAutomationEnabled(
                { ...automationParamsSchema.parse(params), enabled: false },
                { ...appContext, userAuthz: auth.userAuthz },
              ),
            ),
        )
        .post(
          "/projects/:projectId/automations/:key/schedules/:ruleKey/runs",
          {
            params: scheduleParamsSchema,
            response: responseSchemas({
              201: runAutomationScheduleResultSchema,
              409: apiErrorResponseSchema,
              ...errorResponses,
            }),
            detail: {
              operationId: "runAutomationSchedule",
              description:
                "Run now: fires the schedule rule `ruleKey` of the project automation `key` once, for `scheduledFor` = now, through the same path and concurrency check as the minutely tick. Requires `executions:write`. Works while the automation is disabled and does not change the schedule's next run. `taskId` is null when the rule routed to `skip`. Responds 409 `Scarn.ConcurrencyGroupFull` when the schedule's concurrency group is full: no Task is created, `meta.heldBy` names the Tasks that hold the group, and the schedule summary does not count a skip. Responds 409 `AUTOMATION_SCHEDULE_RUN_CONFLICT` when another Run now landed on the same instant.",
              tags,
            },
          },
          async ({ params, auth, set }) => {
            const result = Result.unwrap(
              await runScheduleNow(scheduleParamsSchema.parse(params), {
                ...appContext,
                userAuthz: auth.userAuthz,
              }),
            );
            set.status = 201;
            return result;
          },
        )
        .post(
          "/work-items/:workItemId/automations/:key",
          {
            params: workItemAutomationParamsSchema,
            response: responseSchemas({
              200: workItemAutomationSchema,
              ...errorResponses,
            }),
            detail: { operationId: "attachWorkItemAutomation", tags },
          },
          async ({ params, auth }) =>
            Result.unwrap(
              await attachWorkItemAutomation(
                workItemAutomationParamsSchema.parse(params),
                { ...appContext, userAuthz: auth.userAuthz },
              ),
            ),
        )
        .delete(
          "/work-items/:workItemId/automations/:key",
          {
            params: workItemAutomationParamsSchema,
            response: responseSchemas({
              200: z.object({ detached: z.literal(true) }),
              ...errorResponses,
            }),
            detail: { operationId: "detachWorkItemAutomation", tags },
          },
          async ({ params, auth }) =>
            Result.unwrap(
              await detachWorkItemAutomation(
                workItemAutomationParamsSchema.parse(params),
                { ...appContext, userAuthz: auth.userAuthz },
              ),
            ),
        ),
    );
