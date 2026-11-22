import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import {
  assertProjectPermission,
  resolveProjectPermissionGrant,
} from "@scarn/core/projects/project/application/project-authorization";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type {
  WorkItemListAssigneeFilter,
  WorkItemListPageOptions,
  WorkItemRepo,
} from "./work-item-repo";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type {
  UserDisplay,
  UsernameReader,
} from "@scarn/core/organizations/organization/application/username-reader";
import {
  listWorkItemsQuerySchema,
  type ListWorkItemsQuery,
  type ListWorkItemsQueryInput,
  type PaginatedWorkItemsContract,
} from "../contracts/work-item-contracts";

type ListWorkItemsByProjectDeps = {
  userAuthz: UserAuthorizationService;
  projectRepo: ProjectRepo;
  workItemRepo: WorkItemRepo;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Translate the parsed contract query into repository options. The `score`
 * branch's pipeline id is re-parsed into a branded `UuidV7` here, at the
 * application boundary, so `infra` never has to widen its types; the
 * `created`/`updated` branches pass through unchanged since they carry no
 * ids to re-parse.
 *
 * `includeAwaitingApprovalData` is resolved by the caller from the caller's
 * `work-item-platform-comment:create` permission, never from `query` itself
 * (deviates from decisions 13/14 of `docs/plans/awaiting-approval-filter.md`,
 * which gated this on the more permissive `comments:read` — that let a
 * caller see the "Awaiting approval" badge without being able to see the
 * draft it refers to on the detail page, since the detail page's card is
 * gated on `work-item-platform-comment:create`; aligning both surfaces to
 * the stricter permission closes that gap). When `false`, `awaitingApproval`
 * is dropped here regardless of what the request sent — the request still
 * returns 200 with the filter silently having no effect, rather than a 403
 * that would itself disclose the missing permission.
 */
const toAssigneeFilter = (
  assignee: ListWorkItemsQuery["assignee"],
  viewerUserId: UuidV7,
): WorkItemListAssigneeFilter | undefined => {
  switch (assignee) {
    case undefined:
      return undefined;
    case "none":
      return { kind: "none" };
    case "me":
      return { kind: "user", userId: viewerUserId };
    default:
      return { kind: "user", userId: parseUuidV7(assignee) };
  }
};

const toListPageOptions = (
  query: ListWorkItemsQuery,
  includeAwaitingApprovalData: boolean,
  viewerUserId: UuidV7,
): WorkItemListPageOptions => ({
  search: query.q,
  fieldFilters: query.fieldFilters,
  labels: query.labels,
  updatedAfter: query.updatedAfter,
  updatedBefore: query.updatedBefore,
  awaitingApproval: includeAwaitingApprovalData
    ? query.awaitingApproval
    : undefined,
  includeAwaitingApprovalData,
  viewerUserId,
  assignee: toAssigneeFilter(query.assignee, viewerUserId),
  agent: query.agent,
  latestExecutionStatus: query.latestExecutionStatus,
  platform: query.platform,
  sort:
    query.sort?.kind === "score"
      ? {
          kind: "score",
          pipelineDefinitionId: parseUuidV7(query.sort.pipelineDefinitionId),
          stepKey: query.sort.stepKey,
          signalKey: query.sort.signalKey,
          direction: query.sort.direction,
        }
      : query.sort,
  page: query.page,
  pageSize: query.pageSize,
});

export const listWorkItemsByProject = async (
  input: string,
  queryInput: ListWorkItemsQueryInput,
  {
    userAuthz,
    projectRepo,
    workItemRepo,
    usernameReader,
    timeProvider,
    dbExecutor,
  }: ListWorkItemsByProjectDeps,
): Promise<Result<PaginatedWorkItemsContract, ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(input));
  const query = listWorkItemsQuerySchema.parse(queryInput);

  // This is an authorization + existence gate only (the project contract is
  // discarded), so it checks membership directly rather than going through
  // `getProject` — that use case now also resolves the owner username, an
  // unnecessary read here.
  const project = await projectRepo.load(projectId, dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  assertProjectPermission(project, userAuthz.actorId, "work-items:read");

  // A narrower, separate gate from the `work-items:read` check above: a
  // caller can have list access without approval access, so `awaitingApproval`
  // and its count are only ever computed for a caller who also holds
  // `work-item-platform-comment:create` — the same permission that gates
  // the pending-draft card on the work item detail page
  // (`work-item-comments-section.tsx:57-63`). Deliberately the *same*
  // permission as the detail page, not `comments:read`: a caller who can
  // see the badge must also be able to open the item and see the draft the
  // badge refers to. Non-throwing on purpose — see
  // `resolveProjectPermissionGrant`'s own doc comment.
  const includeAwaitingApprovalData =
    resolveProjectPermissionGrant(
      project,
      userAuthz.actorId,
      "work-item-platform-comment:create",
    ) !== null;

  const page = await workItemRepo.listPageByProjectId(
    projectId,
    toListPageOptions(query, includeAwaitingApprovalData, userAuthz.actorId),
    timeProvider.now(),
    dbExecutor,
  );

  const assigneeIds = page.items.flatMap(({ workItem }) =>
    workItem.assigneeUserId === null ? [] : [workItem.assigneeUserId],
  );
  const assigneeDisplays =
    assigneeIds.length === 0
      ? new Map<UuidV7, UserDisplay>()
      : await usernameReader.loadUsernamesByUserId(assigneeIds, dbExecutor);

  return Result.ok({
    items: page.items.map(
      ({
        workItem,
        signalScore,
        latestExecutionStatus,
        awaitingApprovalCount,
        taskStatusCounts,
      }) => ({
        ...workItemEntityToContract(workItem),
        signalScore,
        latestExecutionStatus,
        awaitingApprovalCount,
        assignee:
          workItem.assigneeUserId === null
            ? null
            : {
                userId: workItem.assigneeUserId,
                username:
                  assigneeDisplays.get(workItem.assigneeUserId)?.username ??
                  null,
                image:
                  assigneeDisplays.get(workItem.assigneeUserId)?.image ?? null,
              },
        taskStatusCounts,
      }),
    ),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
    },
  });
};
