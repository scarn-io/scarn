import type { AppContext } from "@scarn/core/lib/di";
import { DEMO_ACCOUNT_USERNAME, DEMO_PROJECT_SLUG } from "../demo-account";
import { DEMO_PIPELINE_FIXTURES } from "../demo-project-fixtures";
import { resetDemoCouponDoubleApplyFlagship } from "./seed-demo-coupon-double-apply-flagship";
import { resetDemoPerfRegressionBisectFlagship } from "./seed-demo-perf-regression-bisect-flagship";
import { resetDemoNeedsInput } from "./seed-demo-needs-input";

/**
 * Deletes the demo project's existing pipeline runs for every fixed demo work
 * item — their attempts, node runs, evaluations, events, tasks,
 * logs, and artifacts — leaving the demo user/org/project/pipeline-graphs/
 * work-items themselves untouched.
 *
 * Needed because `ensureDemoWorkItemExecution` is idempotent on
 * `(workItemId, pipelineDefinitionId)` (a `PipelineGraph` id, on the new
 * engine): once a run exists for a fixture, re-running `seedDemoProject`
 * skips it forever. Without this, every iteration on the fixtures locally —
 * or retrofitting an environment where the demo project was already seeded —
 * would no-op against already-created rows.
 *
 * Definitions are deliberately not reset here: `ensureDemoStepDefinition` and
 * `ensureDemoPipelineDefinition` bring those in line with the fixtures on
 * every seed run, so a fixture's shape change (e.g. adding a step) lands
 * without needing this.
 *
 * Safe to call against a completely fresh environment: if the demo account's
 * personal org, its project, a fixture's pipeline graph, or a fixture's work
 * item doesn't exist yet, there is nothing to reset for it and it is skipped
 * silently — this function never creates the account/org/project, only looks
 * them up.
 */
export const resetDemoExecutions = async (
  appContext: AppContext,
): Promise<void> => {
  const {
    orgRepo,
    projectRepo,
    workItemRepo,
    pipelineGraphRepo,
    pipelineRunRepo,
    taskRepo,
  } = appContext;

  const org = await orgRepo.loadPersonalOrgByOwnerUsername(
    DEMO_ACCOUNT_USERNAME,
  );
  if (!org) {
    return;
  }
  const project = await projectRepo.loadByOrgAndSlug(org.id, DEMO_PROJECT_SLUG);
  if (!project) {
    return;
  }

  for (const pipelineFixture of DEMO_PIPELINE_FIXTURES) {
    const pipelineGraphHandle = await pipelineGraphRepo.findHandleByKey(
      project.id,
      pipelineFixture.key,
    );
    if (!pipelineGraphHandle) {
      continue;
    }

    for (const workItemFixture of pipelineFixture.workItems) {
      // `notStarted` fixtures never got an execution — see
      // `ensureDemoWorkItemExecution`.
      if (workItemFixture.outcome === "notStarted") {
        continue;
      }

      const workItem = await workItemRepo.loadByPlatformIdentity(
        project.id,
        "scarn",
        workItemFixture.platformKey,
      );
      if (!workItem) {
        continue;
      }

      const orphanedTaskIds =
        await pipelineRunRepo.deleteByWorkItemAndPipelineGraphId(
          workItem.id,
          pipelineGraphHandle.id,
        );
      if (orphanedTaskIds.length > 0) {
        await taskRepo.deleteMany(orphanedTaskIds);
      }
    }
  }

  // Neither flagship is part of `DEMO_PIPELINE_FIXTURES` (see each module's
  // own doc comment), so each needs its own reset call. Only their executions
  // are deleted here — the shared `Triage & Investigate` pipeline definition
  // itself is left in place, same as every other definition.
  await resetDemoCouponDoubleApplyFlagship(appContext, project.id);
  await resetDemoPerfRegressionBisectFlagship(appContext, project.id);
  await resetDemoNeedsInput(appContext, project.id);
};
