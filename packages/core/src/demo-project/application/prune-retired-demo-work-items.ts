import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { RETIRED_DEMO_WORK_ITEM_KEYS } from "../demo-project-fixtures";

/**
 * Deletes demo work items that used to be in `DEMO_PIPELINE_FIXTURES` and no
 * longer are, along with every execution they accumulated.
 *
 * Dropping a fixture from the array is not enough on its own: the seed only
 * ever ensures the fixtures it can see, so a retired work item and its
 * executions sit in an already-seeded project forever, cluttering the work
 * items table and the pipeline's run history with runs the demo no longer
 * talks about. Retired keys are listed explicitly in
 * `RETIRED_DEMO_WORK_ITEM_KEYS` rather than inferred by diffing the project
 * against the fixtures, so the seed never deletes a row it wasn't told about
 * by name.
 *
 * Executions have to go first — `pipeline_runs.work_item_id` is
 * `ON DELETE RESTRICT` — and their tasks after that, since those are
 * rooted at the project, not the execution.
 *
 * Idempotent: a key that has already been pruned (or never existed in this
 * environment) is skipped.
 */
export const pruneRetiredDemoWorkItems = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<void> => {
  const { workItemRepo, pipelineGraphRepo, pipelineRunRepo, taskRepo } =
    appContext;

  const pipelineGraphs = await pipelineGraphRepo.listByProjectId(projectId, {
    includeArchived: true,
  });

  for (const platformKey of RETIRED_DEMO_WORK_ITEM_KEYS) {
    const workItem = await workItemRepo.loadByPlatformIdentity(
      projectId,
      "scarn",
      platformKey,
    );
    if (!workItem) {
      continue;
    }

    // Which pipeline a retired item ran under isn't recorded anywhere, so try
    // every graph in the project — `deleteByWorkItemAndPipelineGraphId` is a
    // no-op for pairs that never had a run.
    for (const pipelineGraph of pipelineGraphs) {
      const orphanedTaskIds =
        await pipelineRunRepo.deleteByWorkItemAndPipelineGraphId(
          workItem.id,
          pipelineGraph.handle.id,
        );
      if (orphanedTaskIds.length > 0) {
        await taskRepo.deleteMany(orphanedTaskIds);
      }
    }

    await workItemRepo.delete(workItem.id);
  }
};
