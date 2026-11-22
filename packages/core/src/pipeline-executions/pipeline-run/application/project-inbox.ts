import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import type { TaskSummaryReader } from "@scarn/core/tasks/task/application/task-summary-reader";
import {
  MAX_PROJECT_INBOX_WAITS,
  MAX_PROJECT_INBOX_WORK_ITEMS,
  type ProjectInboxSummaryContract,
  type ProjectInboxWaitsContract,
} from "../contracts/project-inbox-contracts";
import type { ProjectInboxWaitReader } from "./project-inbox-wait-reader";

type ProjectInboxDeps = {
  userAuthz: UserAuthorizationService;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The inbox is the viewer's own, so it needs a membership: a public project's
 * read grant to non-members isn't enough. 404 for an unknown project, 403 for
 * a non-member.
 */
const requireProjectMember = async (
  projectIdInput: string,
  { userAuthz, dbExecutor }: ProjectInboxDeps,
): Promise<UuidV7> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(projectIdInput));
  const grant = await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor,
  });
  if (!grant.membership) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: "You are not a member of this project",
      status: 403,
      meta: { permission: "executions:read" },
    });
  }
  return projectId;
};

/**
 * The project's open pipeline questions and decision waits on the viewer,
 * newest first, and the ready work items never given a Task that wait on
 * them, most recently ready first.
 */
export const listProjectInboxWaits = async (
  projectIdInput: string,
  deps: ProjectInboxDeps & {
    projectInboxWaitReader: ProjectInboxWaitReader;
    usernameReader: UsernameReader;
  },
): Promise<ProjectInboxWaitsContract> => {
  const projectId = await requireProjectMember(projectIdInput, deps);
  const userId = deps.userAuthz.actorId;
  const [records, workItems] = await Promise.all([
    deps.projectInboxWaitReader.listOnUser(
      projectId,
      userId,
      MAX_PROJECT_INBOX_WAITS,
      deps.dbExecutor,
    ),
    deps.projectInboxWaitReader.listWorkItemsOnUser(
      projectId,
      userId,
      MAX_PROJECT_INBOX_WORK_ITEMS,
      deps.dbExecutor,
    ),
  ]);
  const usernames = await deps.usernameReader.loadUsernamesByUserId(
    [
      ...new Set(
        [...records, ...workItems].flatMap((record) => record.waitingOnUserIds),
      ),
    ],
    deps.dbExecutor,
  );
  const people = (userIds: UuidV7[]) =>
    userIds.map((id) => ({
      userId: id,
      username: usernames.get(id)?.username ?? null,
    }));
  return {
    waits: records.map(({ pipelineRunId, waitingOnUserIds, ...record }) => ({
      ...record,
      pipelineExecutionId: pipelineRunId,
      waitingOn: people(waitingOnUserIds),
    })),
    workItems: workItems.map(({ waitingOnUserIds, ...workItem }) => ({
      ...workItem,
      waitingOn: people(waitingOnUserIds),
    })),
  };
};

/** The counts behind the viewer's inbox badge in the project. */
export const getProjectInboxSummary = async (
  projectIdInput: string,
  deps: ProjectInboxDeps & {
    projectInboxWaitReader: ProjectInboxWaitReader;
    taskSummaryReader: TaskSummaryReader;
  },
): Promise<ProjectInboxSummaryContract> => {
  const projectId = await requireProjectMember(projectIdInput, deps);
  const userId = deps.userAuthz.actorId;
  const [taskCounts, pipelineWaitsOnMe, workItemsWaitingOnMe] =
    await Promise.all([
      deps.taskSummaryReader.countInbox(projectId, userId, deps.dbExecutor),
      deps.projectInboxWaitReader.countOnUser(
        projectId,
        userId,
        deps.dbExecutor,
      ),
      deps.projectInboxWaitReader.countWorkItemsOnUser(
        projectId,
        userId,
        deps.dbExecutor,
      ),
    ]);
  return {
    waitingOnMe: taskCounts.agentWaitingOnUser,
    failedStartedByMe: taskCounts.failedStartedByUser,
    pipelineWaitsOnMe,
    workItemsWaitingOnMe,
    badgeCount:
      taskCounts.agentWaitingOnUser +
      pipelineWaitsOnMe +
      taskCounts.failedStartedByUser +
      workItemsWaitingOnMe,
    waitingOnOthers: taskCounts.waitingOnOthers,
  };
};
