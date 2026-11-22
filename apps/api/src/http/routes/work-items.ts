import { Elysia } from "elysia";
import { apiErrorResponseSchema } from "../../contracts";
import { z } from "zod";
import { Result } from "@scarn/core/lib/result";
import {
  createWorkItem,
  createWorkItems,
} from "@scarn/core/work-items/work-item/application/create-work-item";
import {
  upsertWorkItem,
  upsertWorkItems,
} from "@scarn/core/work-items/work-item/application/upsert-work-item";
import { editWorkItem } from "@scarn/core/work-items/work-item/application/edit-work-item";
import { labelWorkItemForUser } from "@scarn/core/work-items/work-item/application/label-work-item-for-user";
import { setWorkItemParent } from "@scarn/core/work-items/work-item/application/set-work-item-parent";
import { setWorkItemStateForUser } from "@scarn/core/work-items/work-item/application/set-work-item-state";
import {
  createWorkItemInputSchema,
  deleteWorkItemsInputSchema,
  editWorkItemBodySchema,
  editWorkItemInputSchema,
  getWorkItemInputSchema,
  labelWorkItemBodySchema,
  setWorkItemParentInputSchema,
  setWorkItemStateBodySchema,
  workItemSchema,
  upsertWorkItemInputSchema,
  upsertWorkItemsInputSchema,
} from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { type AppContext } from "@scarn/core/lib/di";
import { getWorkItem } from "@scarn/core/work-items/work-item/application/get-work-item";
import { listWorkItemChildren } from "@scarn/core/work-items/work-item/application/list-work-item-children";
import { childWorkItemSchema } from "@scarn/core/work-items/work-item/contracts/child-work-item-contracts";
import { listWorkItemActivity } from "@scarn/core/work-items/work-item-activity/application/list-work-item-activity";
import { workItemActivityEntrySchema } from "@scarn/core/work-items/work-item-activity/contracts/work-item-activity-contracts";
import {
  deleteWorkItems,
  deleteWorkItem,
} from "@scarn/core/work-items/work-item/application/delete-work-items";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { responseSchemas } from "../response-schemas";

const workItemIdParamsSchema = z.object({ workItemId: getWorkItemInputSchema });

const deleteWorkItemsBodySchema = z.object({
  input: deleteWorkItemsInputSchema,
});

const setWorkItemParentBodySchema = setWorkItemParentInputSchema.omit({
  workItemId: true,
});

// Split so `GET /work-items/:workItemId` can serve non-members of a public
// project — including fully anonymous callers — without exposing the write
// endpoints below to unauthenticated requests. See `createOptionallyAuthenticated`.
const createWorkItemReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/work-items/:workItemId",
      {
        params: workItemIdParamsSchema,
        response: responseSchemas({
          200: workItemSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "getWorkItem", tags: ["WorkItems"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getWorkItem(workItemIdParamsSchema.parse(params).workItemId, {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    .get(
      "/work-items/:workItemId/children",
      {
        params: workItemIdParamsSchema,
        response: responseSchemas({
          200: z.array(childWorkItemSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listWorkItemChildren",
          tags: ["WorkItems"],
          description:
            "Lists a work item's direct children, oldest first, each with its status (`needs_person`, `running`, `ready`, `blocked` or `closed`), assignee, open blockers' titles and newest Task: its step, first start, and the question it handed over or the error it failed with.",
        },
      },
      async ({ params, auth }) =>
        await listWorkItemChildren(
          workItemIdParamsSchema.parse(params).workItemId,
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .get(
      "/work-items/:workItemId/activity",
      {
        params: workItemIdParamsSchema,
        response: responseSchemas({
          200: z.array(workItemActivityEntrySchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "listWorkItemActivity", tags: ["WorkItems"] },
      },
      async ({ params, auth }) =>
        await listWorkItemActivity(
          workItemIdParamsSchema.parse(params).workItemId,
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    );

const createWorkItemWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/work-items",
      {
        body: createWorkItemInputSchema,
        response: responseSchemas({
          200: workItemSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "createWorkItem", tags: ["WorkItems"] },
      },
      async ({ body, auth }) =>
        Result.unwrap(
          await createWorkItem(createWorkItemInputSchema.parse(body), {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    .post(
      "/work-items/batch",
      {
        body: upsertWorkItemsInputSchema,
        response: responseSchemas({
          200: z.array(workItemSchema),
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "createWorkItems", tags: ["WorkItems"] },
      },
      async ({ body, auth }) =>
        Result.unwrap(
          await createWorkItems(upsertWorkItemsInputSchema.parse(body), {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    .put(
      "/work-items",
      {
        body: upsertWorkItemInputSchema,
        response: responseSchemas({
          200: workItemSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "upsertWorkItem", tags: ["WorkItems"] },
      },
      async ({ body, auth }) =>
        await upsertWorkItem(upsertWorkItemInputSchema.parse(body), {
          ...appContext,
          userAuthz: auth.userAuthz,
        }),
    )
    .patch(
      "/work-items/:workItemId",
      {
        params: workItemIdParamsSchema,
        body: editWorkItemBodySchema,
        response: responseSchemas({
          200: workItemSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "editWorkItem",
          tags: ["WorkItems"],
          description:
            "A description edit names the descriptionVersion it loaded. 409 when the description has changed since.",
        },
      },
      async ({ params, body, auth }) =>
        await editWorkItem(
          editWorkItemInputSchema.parse({
            ...editWorkItemBodySchema.parse(body),
            workItemId: workItemIdParamsSchema.parse(params).workItemId,
          }),
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .patch(
      "/work-items/:workItemId/labels",
      {
        params: workItemIdParamsSchema,
        body: labelWorkItemBodySchema,
        response: responseSchemas({
          200: workItemSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "labelWorkItem",
          tags: ["WorkItems"],
          description:
            "Add then remove labels on a native work item. 409 for a synced item, whose labels come from its tracker.",
        },
      },
      async ({ params, body, auth }) =>
        await labelWorkItemForUser(
          {
            ...labelWorkItemBodySchema.parse(body),
            workItemId: workItemIdParamsSchema.parse(params).workItemId,
          },
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .patch(
      "/work-items/:workItemId/parent",
      {
        params: workItemIdParamsSchema,
        body: setWorkItemParentBodySchema,
        response: responseSchemas({
          200: workItemSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "setWorkItemParent", tags: ["WorkItems"] },
      },
      async ({ params, body, auth }) =>
        await setWorkItemParent(
          setWorkItemParentInputSchema.parse({
            workItemId: workItemIdParamsSchema.parse(params).workItemId,
            parentWorkItemId:
              setWorkItemParentBodySchema.parse(body).parentWorkItemId,
          }),
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .put(
      "/work-items/:workItemId/state",
      {
        params: workItemIdParamsSchema,
        body: setWorkItemStateBodySchema,
        response: responseSchemas({
          200: workItemSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "setWorkItemState", tags: ["WorkItems"] },
      },
      async ({ params, body, auth }) =>
        await setWorkItemStateForUser(
          {
            ...setWorkItemStateBodySchema.parse(body),
            workItemId: workItemIdParamsSchema.parse(params).workItemId,
          },
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .put(
      "/work-items/batch",
      {
        body: upsertWorkItemsInputSchema,
        response: responseSchemas({
          200: z.array(workItemSchema),
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "upsertWorkItems", tags: ["WorkItems"] },
      },
      async ({ body, auth }) =>
        await upsertWorkItems(upsertWorkItemsInputSchema.parse(body), {
          ...appContext,
          userAuthz: auth.userAuthz,
        }),
    )
    .delete(
      "/work-items/:workItemId",
      {
        params: workItemIdParamsSchema,
        response: responseSchemas({
          200: z.number(),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "deleteWorkItem", tags: ["WorkItems"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await deleteWorkItem(
            workItemIdParamsSchema.parse(params).workItemId,
            {
              ...appContext,
              userAuthz: auth.userAuthz,
            },
          ),
        ),
    )
    .delete(
      "/work-items/batch",
      {
        body: deleteWorkItemsBodySchema,
        response: responseSchemas({
          200: z.number(),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "deleteWorkItems", tags: ["WorkItems"] },
      },
      async ({ body, auth }) =>
        Result.unwrap(
          await deleteWorkItems(deleteWorkItemsBodySchema.parse(body).input, {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    );

export const createWorkItemsRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createWorkItemReadRoutes(appContext))
    .use(createWorkItemWriteRoutes(appContext));
