import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import {
  getProjectInboxSummary,
  listProjectInboxWaits,
} from "@scarn/core/pipeline-executions/pipeline-run/application/project-inbox";
import {
  projectInboxSummarySchema,
  projectInboxWaitsSchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/project-inbox-contracts";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({ projectId: getProjectInputSchema });

/** The viewer's inbox in a project: what waits on them. Members only. */
export const createProjectInboxRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/inbox/waits",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: projectInboxWaitsSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listProjectInboxWaits",
          description:
            "The project's open pipeline waits on the caller, newest first: open questions (`kind: reply`) and decision waits on unfinished runs (`kind: decision`, with the node's actions). A wait is on the caller when they created the work item or started the run. At most 200. `workItems` lists the open, ready work items that have never had a Task and wait on the caller, most recently ready first: the caller is the item's assignee or creator or, when it has neither, the nearest parent's that has either. At most 200. Members only: 403 for a non-member, even on a public project.",
          tags: ["Inbox"],
        },
      },
      async ({ params, auth }) =>
        await listProjectInboxWaits(
          projectParamsSchema.parse(params).projectId,
          {
            userAuthz: auth.userAuthz,
            projectInboxWaitReader: appContext.projectInboxWaitReader,
            usernameReader: appContext.usernameReader,
          },
        ),
    )
    .get(
      "/projects/:projectId/inbox/summary",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: projectInboxSummarySchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getProjectInboxSummary",
          description:
            "The counts behind the caller's inbox badge: agent Tasks waiting on them, open pipeline waits on them, failed Tasks they started (not those of ended chats) and ready work items never given a Task that wait on them (`badgeCount` sums the four), plus the Tasks waiting on someone else. Members only: 403 for a non-member, even on a public project.",
          tags: ["Inbox"],
        },
      },
      async ({ params, auth }) =>
        await getProjectInboxSummary(
          projectParamsSchema.parse(params).projectId,
          {
            userAuthz: auth.userAuthz,
            projectInboxWaitReader: appContext.projectInboxWaitReader,
            taskSummaryReader: appContext.taskSummaryReader,
          },
        ),
    );
