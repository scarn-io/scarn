import { Elysia } from "elysia";
import { apiErrorResponseSchema } from "../../contracts";
import { z } from "zod";
import { listWorkItemComments } from "@scarn/core/work-items/work-item-comment/application/list-work-item-comments";
import { setWorkItemCommentPin } from "@scarn/core/work-items/work-item-comment/application/set-work-item-comment-pin";
import { createWorkItemComment } from "@scarn/core/work-items/work-item-comment/application/create-work-item-comment";
import {
  deleteWorkItemCommentGuarded,
  editWorkItemCommentGuarded,
} from "@scarn/core/pipeline-executions/pipeline-run/application/comment-and-advance";
import {
  createWorkItemCommentInputSchema,
  editWorkItemCommentInputSchema,
  listWorkItemCommentsInputSchema,
  setWorkItemCommentPinInputSchema,
  workItemCommentIdSchema,
  workItemCommentSchema,
} from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
import { type AppContext } from "@scarn/core/lib/di";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { responseSchemas } from "../response-schemas";

const commentIdParamsSchema = z.object({ commentId: workItemCommentIdSchema });
const listWorkItemCommentsQuerySchema = z.object({
  workItemId: listWorkItemCommentsInputSchema,
});
const editWorkItemCommentBodySchema = editWorkItemCommentInputSchema.omit({
  commentId: true,
});
const setWorkItemCommentPinBodySchema = z.object({ isPinned: z.boolean() });

// Split so `GET /work-item-comments` can serve non-members of a public
// project — including fully anonymous callers — without exposing the write
// endpoints below to unauthenticated requests. See `createOptionallyAuthenticated`.
const createWorkItemCommentReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/work-item-comments",
      {
        query: listWorkItemCommentsQuerySchema,
        response: responseSchemas({
          200: z.array(workItemCommentSchema),
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listWorkItemComments",
          tags: ["WorkItemComments"],
        },
      },
      async ({ query, auth }) =>
        await listWorkItemComments(
          listWorkItemCommentsQuerySchema.parse(query).workItemId,
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    );

const createWorkItemCommentWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/work-item-comments",
      {
        body: createWorkItemCommentInputSchema,
        response: responseSchemas({
          200: workItemCommentSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "createWorkItemComment",
          description:
            "Creates a comment, or a reply when `parentCommentId` names a top-level comment. A reply to a question's comment is a plain comment and doesn't answer it; `POST /pipeline-executions/:id/questions/:questionId/answer` does. Requires `comments:write`.",
          tags: ["WorkItemComments"],
        },
      },
      async ({ body, auth }) =>
        await createWorkItemComment(
          createWorkItemCommentInputSchema.parse(body),
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .patch(
      "/work-item-comments/:commentId",
      {
        params: commentIdParamsSchema,
        body: editWorkItemCommentBodySchema,
        response: responseSchemas({
          200: workItemCommentSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "editWorkItemComment",
          description:
            "Edits a comment's body. A question comment can't be edited while its question is open (`WORK_ITEM_COMMENT_QUESTION_OPEN`).",
          tags: ["WorkItemComments"],
        },
      },
      async ({ params, body, auth }) =>
        await editWorkItemCommentGuarded(
          editWorkItemCommentInputSchema.parse({
            commentId: commentIdParamsSchema.parse(params).commentId,
            body: editWorkItemCommentBodySchema.parse(body).body,
          }),
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .post(
      "/work-item-comments/:commentId/pin",
      {
        params: commentIdParamsSchema,
        body: setWorkItemCommentPinBodySchema,
        response: responseSchemas({
          200: workItemCommentSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "setWorkItemCommentPin",
          tags: ["WorkItemComments"],
        },
      },
      async ({ params, body, auth }) =>
        await setWorkItemCommentPin(
          setWorkItemCommentPinInputSchema.parse({
            commentId: commentIdParamsSchema.parse(params).commentId,
            isPinned: setWorkItemCommentPinBodySchema.parse(body).isPinned,
          }),
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    )
    .delete(
      "/work-item-comments/:commentId",
      {
        params: commentIdParamsSchema,
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
          operationId: "deleteWorkItemComment",
          description:
            "Deletes a comment. A question comment can't be deleted while its question is open (`WORK_ITEM_COMMENT_QUESTION_OPEN`).",
          tags: ["WorkItemComments"],
        },
      },
      async ({ params, auth }) =>
        await deleteWorkItemCommentGuarded(
          commentIdParamsSchema.parse(params).commentId,
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        ),
    );

export const createWorkItemCommentsRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createWorkItemCommentReadRoutes(appContext))
    .use(createWorkItemCommentWriteRoutes(appContext));
