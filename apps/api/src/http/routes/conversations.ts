import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { actOnTaskAndAdvance } from "@scarn/core/pipeline-executions/pipeline-run/application/task-and-advance";
import {
  continueTask,
  endTask,
  replyToTask,
} from "@scarn/core/tasks/task/application/reply-to-task";
import {
  getConversation,
  listWorkItemConversations,
  loadConversationFor,
} from "@scarn/core/pipeline-executions/pipeline-run/application/get-conversation";
import { createRepoConversation } from "@scarn/core/conversations/conversation/application/create-repo-conversation";
import { deleteRepoConversation } from "@scarn/core/conversations/conversation/application/delete-repo-conversation";
import { endRepoConversation } from "@scarn/core/conversations/conversation/application/end-repo-conversation";
import { retryRepoConversation } from "@scarn/core/conversations/conversation/application/retry-repo-conversation";
import {
  listProjectConversations,
  withRepoConversationView,
} from "@scarn/core/conversations/conversation/application/repo-conversation-view";
import {
  conversationIdParamsSchema,
  conversationSchema,
  createRepoConversationBodySchema,
  listProjectConversationsQuerySchema,
  projectConversationsPageSchema,
  retryRepoConversationBodySchema,
  sendConversationMessageBodySchema,
  workItemConversationSchema,
} from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import { listWorkItemQuestionsInputSchema } from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { responseSchemas } from "../response-schemas";

/**
 * A Task's conversation between its agent and people: reading it, and
 * replying, continuing without a reply, or ending it, which go to the Task.
 */
const workItemIdParamsSchema = z.object({
  workItemId: listWorkItemQuestionsInputSchema,
});

const projectIdParamsSchema = z.object({ projectId: getProjectInputSchema });

/** The conversation as `userAuthz`'s actor sees it, with a chat's fields. */
const conversationFor = async (
  appContext: AppContext,
  userAuthz: UserAuthorizationService,
  conversationId: string,
) =>
  Result.unwrap(
    await loadConversationFor(
      parseUuidV7(conversationId),
      userAuthz.actorId,
      appContext,
    ),
  );

const errorResponses = {
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  404: apiErrorResponseSchema,
  409: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
};

/** Reads; optionally authenticated so public projects' conversations are readable. */
const createConversationReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/conversations/:conversationId",
      {
        params: conversationIdParamsSchema,
        response: responseSchemas({
          200: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "getConversation",
          description:
            "A conversation with its messages, oldest first, the step visit it belongs to, and how that step ends (`findings` or `conversation`). Requires `executions:read`.",
          tags: ["Conversations"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getConversation(conversationIdParamsSchema.parse(params), {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    .get(
      "/work-items/:workItemId/conversations",
      {
        params: workItemIdParamsSchema,
        response: responseSchemas({
          200: z.array(workItemConversationSchema),
          ...errorResponses,
        }),
        detail: {
          operationId: "listWorkItemConversations",
          description:
            "A work item's conversations, newest first, each with its status, step node and last message time. Requires `executions:read`.",
          tags: ["Conversations"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listWorkItemConversations(
            workItemIdParamsSchema.parse(params).workItemId,
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .get(
      "/projects/:projectId/conversations",
      {
        params: projectIdParamsSchema,
        query: listProjectConversationsQuerySchema,
        response: responseSchemas({
          200: projectConversationsPageSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "listProjectConversations",
          description:
            "A project's chats (repo conversations, not work items' conversations), newest first, each with its first-message preview, creator, derived state, last activity and short pinned commit. Pass `nextCursor` as `before` for the next page. Requires `executions:read`.",
          tags: ["Conversations"],
        },
      },
      async ({ params, query, auth }) =>
        Result.unwrap(
          await listProjectConversations(
            projectIdParamsSchema.parse(params).projectId,
            listProjectConversationsQuerySchema.parse(query),
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    );

const createConversationWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/projects/:projectId/conversations",
      {
        params: projectIdParamsSchema,
        body: createRepoConversationBodySchema,
        response: responseSchemas({
          201: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "createProjectConversation",
          description:
            "Opens a chat about the project's repo with the person's first question (`{ body }` only; any other field is refused with 422) and queues the agent's first turn. Returns 201 with the conversation. Requires `executions:write`.",
          tags: ["Conversations"],
        },
      },
      async ({ params, body, auth, set }) => {
        const created = Result.unwrap(
          await createRepoConversation(
            {
              projectId: projectIdParamsSchema.parse(params).projectId,
              ...createRepoConversationBodySchema.parse(body),
            },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        );
        set.status = 201;
        return await conversationFor(
          appContext,
          auth.userAuthz,
          created.conversationId,
        );
      },
    )
    .post(
      "/conversations/:conversationId/messages",
      {
        params: conversationIdParamsSchema,
        body: sendConversationMessageBodySchema,
        response: responseSchemas({
          200: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "sendConversationMessage",
          description:
            "Replies in a conversation. Requires `comments:create`. The first reply while the agent waits queues its next turn; more replies join that turn until it starts. Refused with `CONVERSATION_NOT_WAITING` once the agent has the floor or the conversation is closed, and on a failed chat with `CONVERSATION_TASK_FAILED` (retry it instead).",
          tags: ["Conversations"],
        },
      },
      async ({ params, body, auth }) =>
        await withRepoConversationView(
          Result.unwrap(
            await actOnTaskAndAdvance(
              replyToTask,
              {
                ...conversationIdParamsSchema.parse(params),
                ...sendConversationMessageBodySchema.parse(body),
              },
              { ...appContext, userAuthz: auth.userAuthz },
            ),
          ),
          auth.userAuthz.actorId,
          appContext,
        ),
    )
    .post(
      "/conversations/:conversationId/continue",
      {
        params: conversationIdParamsSchema,
        response: responseSchemas({
          200: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "continueConversation",
          description:
            "Queues the agent's next turn without a reply. Requires `executions:write`. Only while the conversation waits for a person (`CONVERSATION_NOT_WAITING` otherwise).",
          tags: ["Conversations"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await actOnTaskAndAdvance(
            continueTask,
            conversationIdParamsSchema.parse(params),
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .post(
      "/conversations/:conversationId/done",
      {
        params: conversationIdParamsSchema,
        response: responseSchemas({
          200: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "endConversation",
          description:
            "Ends a conversation step (one with no result schema): the step succeeds with `{ conversationId, summary }`, the summary being the last agent message, and the conversation closes. Requires `executions:write`. Only while the conversation waits for a person (`CONVERSATION_NOT_WAITING`); refused on a step with a result schema (`CONVERSATION_STEP_HAS_RESULT_SCHEMA`).",
          tags: ["Conversations"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await actOnTaskAndAdvance(
            endTask,
            conversationIdParamsSchema.parse(params),
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .post(
      "/conversations/:conversationId/retry",
      {
        params: conversationIdParamsSchema,
        body: retryRepoConversationBodySchema,
        response: responseSchemas({
          200: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "retryProjectConversation",
          description:
            "Retries a failed chat's turn. `expectedLatestRunId` must be the chat's latest run (`latestRun.id`); a stale value gets 409, so repeating a retry makes one new run. Refused on an ended chat (409 `CONVERSATION_ENDED`). Requires `executions:write`. 404 when the conversation isn't a chat.",
          tags: ["Conversations"],
        },
      },
      async ({ params, body, auth }) => {
        const { conversationId } = conversationIdParamsSchema.parse(params);
        Result.unwrap(
          await retryRepoConversation(
            {
              conversationId,
              ...retryRepoConversationBodySchema.parse(body),
            },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        );
        return await conversationFor(
          appContext,
          auth.userAuthz,
          conversationId,
        );
      },
    )
    .post(
      "/conversations/:conversationId/end",
      {
        params: conversationIdParamsSchema,
        response: responseSchemas({
          200: conversationSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "endProjectConversation",
          description:
            "Ends a chat: its conversation closes and a queued, running or waiting turn is cancelled. The transcript stays readable. Ending an ended chat does nothing. Requires `executions:write`, or being its creator with `comments:create`. 404 when the conversation isn't a chat (see `/done` for a conversation step).",
          tags: ["Conversations"],
        },
      },
      async ({ params, auth }) => {
        const { conversationId } = conversationIdParamsSchema.parse(params);
        Result.unwrap(
          await endRepoConversation(
            { conversationId },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        );
        return await conversationFor(
          appContext,
          auth.userAuthz,
          conversationId,
        );
      },
    )
    .delete(
      "/conversations/:conversationId",
      {
        params: conversationIdParamsSchema,
        response: responseSchemas({ 204: z.null(), ...errorResponses }),
        detail: {
          operationId: "deleteProjectConversation",
          description:
            "Deletes a chat in any state, with its transcript, Task, runs, logs, sessions, artifacts and notifications; stored objects are removed after. Returns 204. Same permission as End. 404 when the conversation isn't a chat.",
          tags: ["Conversations"],
        },
      },
      async ({ params, auth }) => {
        Result.unwrap(
          await deleteRepoConversation(
            conversationIdParamsSchema.parse(params),
            {
              ...appContext,
              userAuthz: auth.userAuthz,
            },
          ),
        );
        return new Response(null, { status: 204 });
      },
    );

export const createConversationRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createConversationReadRoutes(appContext))
    .use(createConversationWriteRoutes(appContext));
