import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { AppContext } from "@scarn/core/lib/di";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";

export type ResetLocalDevProjectResult = {
  notifications: number;
  tasks: number;
  workItems: number;
};

/**
 * Clears the `@scarn/local-dev` sandbox project's work so seed can rebuild
 * it: its notifications, pipeline runs, Tasks and work items, in one
 * transaction. The project, its step definitions and its pipeline
 * definitions stay; seed converges those by pushing them again.
 *
 * Order matters because of the `restrict` foreign keys:
 * `pipeline_runs.work_item_id`, `tasks.work_item_id`,
 * `task_runs.work_item_id` and `node_visits.task_id`. Runs go first (their visits, lanes and
 * questions cascade), then every Task and TaskRun (log lines, artifacts,
 * agent sessions and messages cascade), then the work items
 * (comments, blocks, conversations and their messages cascade).
 * Notifications go before all of them because their links are `set null`,
 * so they would otherwise outlive what they point at.
 *
 * Callers must check the environment first: this deletes data outright and
 * does not touch object storage.
 */
export const resetLocalDevProject = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<ResetLocalDevProjectResult> => {
  const {
    projectRepo,
    userNotificationRepo,
    pipelineRunRepo,
    taskRepo,
    workItemRepo,
  } = appContext;

  return await getDb().transaction(async (tx) => {
    const project = await projectRepo.load(projectId, tx);
    if (!project) {
      throw new ResourceNotFoundError("Project", projectId);
    }

    const notifications = await userNotificationRepo.deleteByProjectId(
      projectId,
      tx,
    );
    await pipelineRunRepo.deleteByProjectId(projectId, tx);
    const tasks = await taskRepo.deleteByProjectId(projectId, tx);
    const workItems = await workItemRepo.deleteByProjectId(projectId, tx);

    return { notifications, tasks, workItems };
  });
};
