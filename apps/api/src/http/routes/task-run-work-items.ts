import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createTaskRunWorkItem } from "@scarn/core/tasks/task-run/application/create-task-run-work-item";
import { readTaskRunWorkItem } from "@scarn/core/tasks/task-run/application/read-task-run-work-item";
import {
  createdTaskRunWorkItemSchema,
  createTaskRunWorkItemInputSchema,
  MAX_OPEN_CHILD_WORK_ITEMS,
  MAX_WORK_ITEMS_CREATED_PER_TASK,
  readTaskRunWorkItemInputSchema,
  taskRunWorkItemSchema,
} from "@scarn/core/tasks/task-run/contracts/task-run-work-item-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/**
 * The work item reads and creates a running Task's agent makes through its
 * tools. The claim token is the credential, so these take no session: the
 * agent's runtime holds the run's claim token but never the worker's sign-in.
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
          description: `Creates a child of the running task run's work item for its agent, committed at once, as the user who claimed the run. Needs the Task's \`create\` grant on \`children\`, covering every label; \`blockedBy\` must name existing items that are the Task's own item or its children. At most ${String(MAX_WORK_ITEMS_CREATED_PER_TASK)} items per Task and ${String(MAX_OPEN_CHILD_WORK_ITEMS)} open children per item. Returns 201, or 200 with \`created: false\` when \`workItemId\` already names this Task's child (a retry). Authorized by the claim token alone; no session.`,
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
    );
