import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import {
  DEFAULT_PROJECT_TASKS_LIMIT,
  listProjectTasksQuerySchema,
  type ListProjectTasksQueryInput,
  type ProjectTasksPageContract,
} from "../contracts/task-summary-contracts";
import { taskStatusValues, type TaskStatus } from "../domain/task-entity";
import type {
  ProjectTaskSummaryScope,
  TaskSummaryReader,
} from "./task-summary-reader";
import { taskSummariesToContracts } from "./task-summary-mapper";

/**
 * A project's Tasks, standalone and pipeline step ones, newest first, with
 * how many Tasks have each status under the same filters bar `status`.
 */
export const listProjectTasks = async (
  projectIdInput: string,
  queryInput: ListProjectTasksQueryInput,
  {
    userAuthz,
    projectRepo,
    taskSummaryReader,
    usernameReader,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: ProjectRepo;
    taskSummaryReader: TaskSummaryReader;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ProjectTasksPageContract, ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(projectIdInput));
  const query = listProjectTasksQuerySchema.parse(queryInput);
  const project = await projectRepo.load(projectId, dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor,
  });

  const limit = query.limit ?? DEFAULT_PROJECT_TASKS_LIMIT;
  const scope: ProjectTaskSummaryScope = {
    kind: query.kind,
    waitingOnUserId: query.waitingOnMe ? userAuthz.actorId : undefined,
    startedByUserId: query.startedByMe ? userAuthz.actorId : undefined,
    workItemIds: asList(query.workItemId)?.map(parseUuidV7),
    latestPerWorkItem: query.latestPerWorkItem,
    excludeEndedChats: query.excludeEndedChats,
  };
  const [records, counts] = await Promise.all([
    taskSummaryReader.listByProject(
      projectId,
      {
        ...scope,
        statuses: asList(query.status),
        beforeTaskId: query.before ? parseUuidV7(query.before) : undefined,
        limit: limit + 1,
      },
      dbExecutor,
    ),
    taskSummaryReader.countByStatus(projectId, scope, dbExecutor),
  ]);
  const page = records.slice(0, limit);
  const last = page.at(-1);
  return Result.ok({
    tasks: await taskSummariesToContracts(
      page,
      userAuthz.actorId,
      usernameReader,
      dbExecutor,
    ),
    nextCursor: records.length > limit && last ? last.id : null,
    counts: Object.fromEntries(
      taskStatusValues.map((status) => [status, counts.get(status) ?? 0]),
    ) as Record<TaskStatus, number>,
  });
};

const asList = <T>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];
