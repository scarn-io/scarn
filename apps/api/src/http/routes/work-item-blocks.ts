import { Elysia } from "elysia";
import { apiErrorResponseSchema } from "../../contracts";
import { z } from "zod";
import { createWorkItemBlock } from "@scarn/core/work-items/work-item-block/application/create-work-item-block";
import { deleteWorkItemBlock } from "@scarn/core/work-items/work-item-block/application/delete-work-item-block";
import { listWorkItemBlocks } from "@scarn/core/work-items/work-item-block/application/list-work-item-blocks";
import {
  createWorkItemBlockInputSchema,
  listWorkItemBlocksInputSchema,
  workItemBlockIdSchema,
  workItemBlockSchema,
} from "@scarn/core/work-items/work-item-block/contracts/work-item-block-contracts";
import { type AppContext } from "@scarn/core/lib/di";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { responseSchemas } from "../response-schemas";

const blockIdParamsSchema = z.object({ blockId: workItemBlockIdSchema });
const listWorkItemBlocksQuerySchema = z.object({
  workItemId: listWorkItemBlocksInputSchema,
});
// Mirrors `ListWorkItemBlocksResult` from `work-item-block-contracts.ts` —
// Phase 3 only defined that as a plain TS type (not a zod schema), so the
// response shape is reconstructed here from `workItemBlockSchema`.
const listWorkItemBlocksResponseSchema = z.object({
  blockedBy: z.array(workItemBlockSchema),
  blocking: z.array(workItemBlockSchema),
});

// Split so `GET /work-item-blocks` can serve non-members of a public project
// — including fully anonymous callers — without exposing the write endpoints
// below to unauthenticated requests. See `createOptionallyAuthenticated`.
const createWorkItemBlockReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/work-item-blocks",
      {
        query: listWorkItemBlocksQuerySchema,
        response: responseSchemas({
          200: listWorkItemBlocksResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listWorkItemBlocks",
          tags: ["WorkItemBlocks"],
        },
      },
      async ({ query, auth }) =>
        await listWorkItemBlocks(
          listWorkItemBlocksQuerySchema.parse(query).workItemId,
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    );

const createWorkItemBlockWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/work-item-blocks",
      {
        body: createWorkItemBlockInputSchema,
        response: responseSchemas({
          200: workItemBlockSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "createWorkItemBlock",
          tags: ["WorkItemBlocks"],
        },
      },
      async ({ body, auth }) =>
        await createWorkItemBlock(createWorkItemBlockInputSchema.parse(body), {
          ...appContext,
          userAuthz: auth.userAuthz,
        }),
    )
    .delete(
      "/work-item-blocks/:blockId",
      {
        params: blockIdParamsSchema,
        response: responseSchemas({
          200: z.number(),
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "deleteWorkItemBlock",
          tags: ["WorkItemBlocks"],
        },
      },
      async ({ params, auth }) =>
        await deleteWorkItemBlock(blockIdParamsSchema.parse(params).blockId, {
          ...appContext,
          userAuthz: auth.userAuthz,
        }),
    );

export const createWorkItemBlocksRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createWorkItemBlockReadRoutes(appContext))
    .use(createWorkItemBlockWriteRoutes(appContext));
