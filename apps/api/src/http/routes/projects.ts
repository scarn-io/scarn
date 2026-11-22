import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { getProject } from "@scarn/core/projects/project/application/get-project";
import { resolveProjectBySlug } from "@scarn/core/projects/project/application/resolve-project-by-slug";
import { listProjects } from "@scarn/core/projects/project/application/list-projects";
import { listProjectMembers } from "@scarn/core/projects/project/application/list-project-members";
import { updateProjectMembership } from "@scarn/core/projects/project/application/update-project-membership";
import {
  getProjectInputSchema,
  projectMemberSchema,
  projectMembershipSchema,
  projectSchema,
  updateProjectMemberRoleBodySchema,
} from "@scarn/core/projects/project/contracts/project-contracts";
import { listWorkItemsByProject } from "@scarn/core/work-items/work-item/application/list-work-items-by-project";
import { listWorkItemFieldOptions } from "@scarn/core/work-items/work-item/application/list-work-item-field-options";
import { listWorkItemLabels } from "@scarn/core/work-items/work-item/application/list-work-item-labels";
import { listWorkItemStatuses } from "@scarn/core/work-items/work-item/application/list-work-item-statuses";
import { workItemStatusSummarySchema } from "@scarn/core/work-items/work-item/contracts/child-work-item-contracts";
import {
  paginatedWorkItemsSchema,
  workItemFieldOptionSchema,
} from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import {
  listProjectWorkItemsQuerySchema,
  toListWorkItemsQuery,
} from "./project-work-items-query";
import { responseSchemas } from "../response-schemas";

const parseIdList = (raw: string | string[] | undefined): string[] =>
  [raw ?? []]
    .flat()
    .flatMap((part) => part.split(","))
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

// Listing the actor's own projects. `GET /projects` resolves purely from
// `userAuthz.actorId`, never from a project's `visibility`, so it must never
// be reachable anonymously — unlike the read routes below, it grants no
// access via public-project fallback. Always requires a real session. Listing a
// project's members lives here too: it is members-only, never public.
// Creating a project lives in `projects-setup.ts`.
const createProjectWriteRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects",
      {
        response: responseSchemas({
          200: z.array(projectSchema),
          401: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "listProjects", tags: ["Projects"] },
      },
      async ({ auth }) =>
        await listProjects({
          userAuthz: auth.userAuthz,
          projectRepo: appContext.projectRepo,
          orgRepo: appContext.orgRepo,
          usernameReader: appContext.usernameReader,
        }),
    )
    .get(
      "/projects/:projectId/members",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        response: responseSchemas({
          200: z.array(projectMemberSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listProjectMembers",
          tags: ["Projects"],
          description:
            "The project's members with their username and avatar, ordered by username. Members only: 403 for a non-member, even on a public project.",
        },
      },
      async ({ params: { projectId }, auth }) =>
        await listProjectMembers(projectId, {
          userAuthz: auth.userAuthz,
          projectRepo: appContext.projectRepo,
          usernameReader: appContext.usernameReader,
        }),
    );

// The read side of `/projects`: resolving a single project (by id or by
// owner-username + slug) and its work items / field options. Serves
// non-members of a public project — including fully anonymous callers — via
// `createOptionallyAuthenticated`; each use case's `requireProjectPermission`
// call still enforces the real check (see issue #149).
const createProjectReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/projects/resolve",
      {
        query: z.object({
          username: z.string().trim().min(1),
          slug: z.string().trim().min(1),
        }),
        response: responseSchemas({
          200: projectSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "resolveProjectBySlug", tags: ["Projects"] },
      },
      async ({ query, auth }) =>
        Result.unwrap(
          await resolveProjectBySlug(
            { username: query.username, projectSlug: query.slug },
            {
              userAuthz: auth.userAuthz,
              projectRepo: appContext.projectRepo,
              orgRepo: appContext.orgRepo,
            },
          ),
        ),
    )
    .get(
      "/projects/:projectId/work-items",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        query: listProjectWorkItemsQuerySchema,
        response: responseSchemas({
          200: paginatedWorkItemsSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "listProjectWorkItems", tags: ["Projects"] },
      },
      async ({ params: { projectId }, query, auth }) =>
        Result.unwrap(
          await listWorkItemsByProject(projectId, toListWorkItemsQuery(query), {
            userAuthz: auth.userAuthz,
            projectRepo: appContext.projectRepo,
            workItemRepo: appContext.workItemRepo,
            usernameReader: appContext.usernameReader,
            timeProvider: appContext.timeProvider,
          }),
        ),
    )
    .get(
      "/projects/:projectId/work-item-field-options",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        response: responseSchemas({
          200: z.array(workItemFieldOptionSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listProjectWorkItemFieldOptions",
          tags: ["Projects"],
        },
      },
      async ({ params: { projectId }, auth }) =>
        Result.unwrap(
          await listWorkItemFieldOptions(projectId, {
            userAuthz: auth.userAuthz,
            projectRepo: appContext.projectRepo,
            workItemRepo: appContext.workItemRepo,
          }),
        ),
    )
    .get(
      "/projects/:projectId/work-item-labels",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        response: responseSchemas({
          200: z.array(z.string()),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listProjectWorkItemLabels",
          tags: ["Projects"],
          description:
            "The distinct labels on the project's work items, sorted, for suggestions.",
        },
      },
      async ({ params: { projectId }, auth }) =>
        Result.unwrap(
          await listWorkItemLabels(projectId, {
            userAuthz: auth.userAuthz,
            projectRepo: appContext.projectRepo,
            workItemRepo: appContext.workItemRepo,
          }),
        ),
    )
    .get(
      "/projects/:projectId/work-item-statuses",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        // Elysia splits a comma list into an array before validation, so
        // both shapes arrive here.
        query: z.object({
          ids: z.union([z.string(), z.array(z.string())]).optional(),
        }),
        response: responseSchemas({
          200: z.array(workItemStatusSummarySchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listProjectWorkItemStatuses",
          tags: ["Projects"],
          description:
            "The live title and status (`needs_person`, `running`, `ready`, `blocked` or `closed`) of each comma-separated work item id that is in the project, in the order asked, up to 100. Ids that don't exist, were deleted or are in another project are left out.",
        },
      },
      async ({ params: { projectId }, query, auth }) =>
        Result.unwrap(
          await listWorkItemStatuses(
            { projectId, ids: parseIdList(query.ids) },
            {
              userAuthz: auth.userAuthz,
              projectRepo: appContext.projectRepo,
              workItemRepo: appContext.workItemRepo,
              taskRepo: appContext.taskRepo,
              workItemBlockRepo: appContext.workItemBlockRepo,
            },
          ),
        ),
    )
    .get(
      "/projects/:projectId",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        response: responseSchemas({
          200: projectSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "getProject", tags: ["Projects"] },
      },
      async ({ params: { projectId }, auth }) =>
        Result.unwrap(
          await getProject(projectId, {
            userAuthz: auth.userAuthz,
            projectRepo: appContext.projectRepo,
            orgRepo: appContext.orgRepo,
            usernameReader: appContext.usernameReader,
          }),
        ),
    );

// Project mutations that aren't creation (see `createProjectWriteRoutes`
// above): changing a member's role. Always requires a real session; the
// use case asserts membership + permission on the target project regardless
// of its visibility.
const createProjectMutationRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .put(
      "/projects/:projectId/members/:userId/role",
      {
        params: z.object({
          projectId: getProjectInputSchema,
          userId: uuidV7Schema,
        }),
        body: updateProjectMemberRoleBodySchema,
        response: responseSchemas({
          200: projectMembershipSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "updateProjectMemberRole",
          tags: ["Projects"],
          description:
            "Sets the user's role on the project (`read`, `write` or `admin`) and returns the membership with its resolved permissions. Adds the user as a member when they have no membership. Requires `members:write`. 409 when it would demote the project's only admin.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await updateProjectMembership(
            {
              projectId: params["projectId"],
              userId: params["userId"],
              role: body.role,
            },
            {
              userAuthz: auth.userAuthz,
              projectRepo: appContext.projectRepo,
              timeProvider: appContext.timeProvider,
              managedConnectionRepo: appContext.managedConnectionRepo,
              managedOAuthAttemptRepo: appContext.managedOAuthAttemptRepo,
              managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
              managedConnectionEventRepo: appContext.managedConnectionEventRepo,
            },
          ),
        ),
    );

export const createProjectRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createProjectReadRoutes(appContext))
    .use(createProjectWriteRoutes(appContext))
    .use(createProjectMutationRoutes(appContext));
