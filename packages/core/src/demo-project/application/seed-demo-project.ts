import type { AppContext } from "@scarn/core/lib/di";
import { DEMO_PIPELINE_FIXTURES } from "../demo-project-fixtures";
import { ensureDemoAccountAndProject } from "./seed-demo-account";
import { DEMO_ACCOUNT_USER_ID, DEMO_PROJECT_SLUG } from "../demo-account";
import { ensureDemoPipeline } from "./seed-demo-pipeline";
import { pruneRetiredDemoWorkItems } from "./prune-retired-demo-work-items";
import { pruneRetiredDemoPipelines } from "./prune-retired-demo-pipelines";
import { ensureDemoCouponDoubleApplyFlagship } from "./seed-demo-coupon-double-apply-flagship";
import { ensureDemoPerfRegressionBisectFlagship } from "./seed-demo-perf-regression-bisect-flagship";
import { ensureDemoNeedsInput } from "./seed-demo-needs-input";

export type SeedDemoProjectResult = {
  projectPath: string;
};

/**
 * Idempotently provisions the singleton public demo project (issue #151):
 * the demo account and its personal org, the demo project itself (marked
 * public), two pipelines each with several work items in varied states, two
 * flagships (sharing one branching `Triage & Investigate` pipeline) each
 * replaying a real captured run down a different branch, and completed
 * executions with real logs and artifacts — including at least one
 * deliberately-failed execution with real failure logs.
 *
 * Safe to run repeatedly against the same database, and convergent rather than
 * merely additive: pipeline/step definitions are brought in line with the
 * fixtures on every run (so a shape change lands in an already-seeded
 * environment), work items and executions are created only if missing, and
 * work items named in `RETIRED_DEMO_WORK_ITEM_KEYS` are deleted.
 */
export const seedDemoProject = async (
  appContext: AppContext,
): Promise<SeedDemoProjectResult> => {
  const { projectId, ownerUsername } =
    await ensureDemoAccountAndProject(appContext);
  // The demo account owns its project (see `ensureDemoAccountAndProject`), so
  // this actor has full permissions on every pipeline/work-item/execution
  // write below via its owner membership.
  const userAuthz =
    appContext.createUserAuthorizationService(DEMO_ACCOUNT_USER_ID);

  for (const fixture of DEMO_PIPELINE_FIXTURES) {
    await ensureDemoPipeline(appContext, projectId, userAuthz, fixture);
  }
  // Neither flagship fabricates its content, so neither fits
  // `DEMO_PIPELINE_FIXTURES`' shape — see each module's own doc comment. Both
  // replay a real captured run of the same `Triage & Investigate` pipeline
  // (`triage-and-investigate-pipeline-fixture.ts`), each taking a different
  // branch out of its `choice` node, so it doesn't matter which runs first:
  // whichever seeds first creates the definition with both branches on it.
  await ensureDemoCouponDoubleApplyFlagship(appContext, projectId, userAuthz);
  await ensureDemoPerfRegressionBisectFlagship(
    appContext,
    projectId,
    userAuthz,
  );
  await ensureDemoNeedsInput(appContext, projectId, userAuthz);

  // After the fixtures, not before: pruning is about rows the fixtures no
  // longer describe, and running it last keeps a partially-failed seed from
  // deleting history before the replacement content exists.
  await pruneRetiredDemoWorkItems(appContext, projectId);
  await pruneRetiredDemoPipelines(appContext, projectId);

  return { projectPath: `/${ownerUsername}/${DEMO_PROJECT_SLUG}` };
};
