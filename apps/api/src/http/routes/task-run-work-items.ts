import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createTaskRunWorkItem } from "@scarn/core/tasks/task-run/application/create-task-run-work-item";
import { latestTaskRunSourceUpdate } from "@scarn/core/tasks/task-run/application/latest-task-run-source-update";
import { readTaskRunWorkItem } from "@scarn/core/tasks/task-run/application/read-task-run-work-item";
import { upsertTaskRunWorkItems } from "@scarn/core/tasks/task-run/application/upsert-task-run-work-items";
import {
  createdTaskRunWorkItemSchema,
  createTaskRunWorkItemInputSchema,
  latestTaskRunSourceUpdateInputSchema,
  latestTaskRunSourceUpdateSchema,
  MAX_OPEN_CHILD_WORK_ITEMS,
  MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK,
  MAX_TASK_RUN_WORK_ITEM_UPSERT_BYTES,
  MAX_TASK_RUN_WORK_ITEM_UPSERTS,
  MAX_WORK_ITEMS_CREATED_PER_TASK,
  PROJECT_WORK_ITEM_PLATFORM,
  readTaskRunWorkItemInputSchema,
  taskRunWorkItemSchema,
  upsertedTaskRunWorkItemsSchema,
  upsertTaskRunWorkItemsInputSchema,
} from "@scarn/core/tasks/task-run/contracts/task-run-work-item-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  jsonBodyOfAtMost,
  stdErrors,
  taskRunIdParamsSchema,
} from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/**
 * The work item reads and creates a running Task's agent makes through its
 * tools, and a code step's imports and import cursor. The claim token is the
 * credential, so these take no session: the agent's runtime holds the run's
 * claim token but never the worker's sign-in.
 */
export const createTaskRunWorkItemRoutes = (appContext: AppContext) =>
  new Elysia()
    .post(
      "/task-runs/:taskRunId/work-item-reads",
      {
        params: taskRunIdParamsSchema,
        body: readTaskRunWorkItemInputSchema,
        response: responseSchemas({
          200: taskRunWorkItemSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "readTaskRunWorkItem",
          tags: ["TaskRuns"],
          description:
            "Reads a work item live for the running task run's agent with a `read` grant on `self` for its own item, `children` for a direct child, or `project` for any item in the same project. Returns the description with its `descriptionVersion`, labels, fields and state, and its blockers and children, each with its labels, state, close reason, open blockers (`blockedBy`) and newest Task's status (`latestTaskStatus`). Includes a page of the item's posted comments with display-only author names, totalCount and nextCursor; pass commentsCursor to continue reading that same item's comments. Comments require no additional permission. Authorized by a live claim token alone; no session.",
        },
      },
      async ({ params, body }) =>
        Result.unwrap(
          await readTaskRunWorkItem(
            taskRunIdParamsSchema.parse(params).taskRunId,
            readTaskRunWorkItemInputSchema.parse(body),
            {
              taskRunRepo: appContext.taskRunRepo,
              taskRepo: appContext.taskRepo,
              workItemRepo: appContext.workItemRepo,
              workItemBlockRepo: appContext.workItemBlockRepo,
              workItemCommentRepo: appContext.workItemCommentRepo,
              usernameReader: appContext.usernameReader,
              commentTaskNameReader: appContext.commentTaskNameReader,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/work-item-creates",
      {
        params: taskRunIdParamsSchema,
        body: createTaskRunWorkItemInputSchema,
        response: responseSchemas({
          200: createdTaskRunWorkItemSchema,
          201: createdTaskRunWorkItemSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "createTaskRunWorkItem",
          tags: ["TaskRuns"],
          description: `Creates a work item for the running task run's agent, committed at once, as the user who claimed the run. With \`scope: "children"\` (the default) it is a child of the run's work item: needs the Task's \`create\` grant on \`children\`, covering every label; \`blockedBy\` must name existing items that are the Task's own item or its children; at most ${String(MAX_WORK_ITEMS_CREATED_PER_TASK)} items per Task and ${String(MAX_OPEN_CHILD_WORK_ITEMS)} open children per item. With \`scope: "project"\` it is a top-level item in the Task's project on platform \`${PROJECT_WORK_ITEM_PLATFORM}\`, keyed by the required \`platformKey\`: needs the \`create\` grant on \`project\`, covering every label; takes no \`blockedBy\`; at most ${String(MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK)} items per Task. A code step's run may only create with \`scope: "project"\`, under a \`create\` grant on \`project\` whose \`keyPrefix\` covers the \`platformKey\` and whose labels cover the item's, else 422 \`WORK_ITEM_GRANT_MISSING\`; its creates have no per-Task cap. Returns 201, or 200 with \`created: false\` when \`workItemId\` already names this Task's child (a retry) or the project already has the \`platformKey\` (the existing item, unchanged). Authorized by the claim token alone; no session.`,
        },
      },
      async ({ params, body, set }) => {
        const created = Result.unwrap(
          await createTaskRunWorkItem(
            taskRunIdParamsSchema.parse(params).taskRunId,
            createTaskRunWorkItemInputSchema.parse(body),
            {
              taskRunRepo: appContext.taskRunRepo,
              taskRepo: appContext.taskRepo,
              workItemRepo: appContext.workItemRepo,
              workItemBlockRepo: appContext.workItemBlockRepo,
              workItemEvents: appContext.workItemEvents,
              timeProvider: appContext.timeProvider,
              createUserAuthorizationService:
                appContext.createUserAuthorizationService,
            },
          ),
        );
        set.status = created.created ? 201 : 200;
        return created;
      },
    )
    .post(
      "/task-runs/:taskRunId/work-item-upserts",
      {
        params: taskRunIdParamsSchema,
        body: upsertTaskRunWorkItemsInputSchema,
        parse: [jsonBodyOfAtMost(MAX_TASK_RUN_WORK_ITEM_UPSERT_BYTES), "json"],
        response: responseSchemas({
          200: upsertedTaskRunWorkItemsSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          413: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "upsertTaskRunWorkItems",
          tags: ["TaskRuns"],
          description: `Writes a code step's imported items into its run's project, committed at once in one transaction, as the user who claimed the run, who must hold \`work-items:write\` on the project. Takes at most ${String(MAX_TASK_RUN_WORK_ITEM_UPSERTS)} items on platform \`custom\`, \`jira\` or \`github\`, each keyed by \`(platform, platformKey)\` and carrying a required \`sourceUpdatedAt\`; the body is at most 5 MiB. A key the project lacks needs the step's \`create\` grant on \`project\`, one it has its \`update\` grant, each covering the key's \`keyPrefix\` and the item's labels; any miss fails the whole call with 422 \`WORK_ITEM_GRANT_MISSING\` and writes nothing. An item overwrites a stored one only when its \`sourceUpdatedAt\` is strictly newer; older ones are left out of \`items\` and counted as \`unchanged\`. A closed source item closes the stored one and an open one reopens it. Authorized by the claim token alone; no session.`,
        },
      },
      async ({ params, body }) =>
        Result.unwrap(
          await upsertTaskRunWorkItems(
            taskRunIdParamsSchema.parse(params).taskRunId,
            upsertTaskRunWorkItemsInputSchema.parse(body),
            {
              taskRunRepo: appContext.taskRunRepo,
              taskRepo: appContext.taskRepo,
              workItemRepo: appContext.workItemRepo,
              workItemBlockRepo: appContext.workItemBlockRepo,
              workItemEvents: appContext.workItemEvents,
              timeProvider: appContext.timeProvider,
              createUserAuthorizationService:
                appContext.createUserAuthorizationService,
            },
          ),
        ),
    )
    .post(
      "/task-runs/:taskRunId/work-item-source-cursor",
      {
        params: taskRunIdParamsSchema,
        body: latestTaskRunSourceUpdateInputSchema,
        response: responseSchemas({
          200: latestTaskRunSourceUpdateSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "latestTaskRunSourceUpdate",
          tags: ["TaskRuns"],
          description:
            "A code step's import cursor: the newest `sourceUpdatedAt` among its run's project's items on `platform` whose `platformKey` starts with `keyPrefix` (matched literally), or null when there is none. Needs the step's `read` grant on `project` (else 422 `WORK_ITEM_GRANT_MISSING`) and the claiming user's `work-items:read`. Authorized by the claim token alone; no session.",
        },
      },
      async ({ params, body }) =>
        Result.unwrap(
          await latestTaskRunSourceUpdate(
            taskRunIdParamsSchema.parse(params).taskRunId,
            latestTaskRunSourceUpdateInputSchema.parse(body),
            {
              taskRunRepo: appContext.taskRunRepo,
              taskRepo: appContext.taskRepo,
              workItemRepo: appContext.workItemRepo,
              timeProvider: appContext.timeProvider,
              createUserAuthorizationService:
                appContext.createUserAuthorizationService,
            },
          ),
        ),
    );
