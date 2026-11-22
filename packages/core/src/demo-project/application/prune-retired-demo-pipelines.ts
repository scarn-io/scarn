import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { RETIRED_DEMO_PIPELINE_KEYS } from "./triage-and-investigate-pipeline-fixture";
import { COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY } from "./seed-demo-coupon-double-apply-flagship";
import { PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY } from "./seed-demo-perf-regression-bisect-flagship";

/**
 * Retires the three chain-shaped pipeline definitions the flagships used
 * before they were merged into one graph-shaped `Triage & Investigate`
 * pipeline: `intake_router` and the two downstream pipelines its `route`
 * advancement event dispatched to.
 *
 * Needed because the seed is convergent, not merely additive, and nothing
 * else converges these away: `ensureDemoFlagshipPipelineDefinition` publishes
 * under a new key, so in an environment seeded before the merge the three old
 * definitions and their executions sit there forever — the demo project would
 * show four pipelines and four executions for two work items, with two of the
 * executions telling the old cross-pipeline story.
 *
 * Executions go first (and their tasks after that, since those are
 * rooted at the project rather than the execution), then the handle is
 * archived rather than deleted: `PipelineGraphRepo` has no delete, and
 * archiving is enough to take a pipeline out of `listByProjectId` and so out
 * of the demo project's UI.
 *
 * Idempotent, and safe against a fresh environment: a pipeline key or work
 * item that doesn't exist here is skipped.
 */
export const pruneRetiredDemoPipelines = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<void> => {
  const {
    workItemRepo,
    pipelineGraphRepo,
    pipelineRunRepo,
    taskRepo,
    timeProvider,
  } = appContext;

  const flagshipWorkItems = (
    await Promise.all(
      [
        COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
        PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY,
      ].map(
        async (platformKey) =>
          await workItemRepo.loadByPlatformIdentity(
            projectId,
            "scarn",
            platformKey,
          ),
      ),
    )
  ).filter((workItem) => workItem !== null);

  for (const pipelineKey of RETIRED_DEMO_PIPELINE_KEYS) {
    const handle = await pipelineGraphRepo.findHandleByKey(
      projectId,
      pipelineKey,
    );
    if (!handle) {
      continue;
    }

    for (const workItem of flagshipWorkItems) {
      const orphanedTaskIds =
        await pipelineRunRepo.deleteByWorkItemAndPipelineGraphId(
          workItem.id,
          handle.id,
        );
      if (orphanedTaskIds.length > 0) {
        await taskRepo.deleteMany(orphanedTaskIds);
      }
    }

    if (!handle.isArchived) {
      await pipelineGraphRepo.updateHandle(handle.archive(timeProvider.now()));
    }
  }
};
