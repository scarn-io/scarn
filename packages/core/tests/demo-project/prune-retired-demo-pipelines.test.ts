/**
 * DB-backed coverage for `pruneRetiredDemoPipelines` — the convergence step
 * that retires the three chain-shaped pipelines the flagships used before
 * they were merged into the one graph-shaped `Triage & Investigate` pipeline.
 *
 * Worth its own file because it is the one part of the seed that does nothing
 * on a fresh database: every other test in this directory starts from an
 * empty project, where there is nothing retired to prune, so the only
 * environment that exercises this code is the already-seeded deployed demo —
 * the worst possible place to find out it doesn't work. This file stands up
 * the pre-merge state by hand (a pipeline under a retired key, with a real
 * execution for a real flagship work item) and proves the prune converges it.
 *
 * Placement: same reasoning as `seed-demo-pipeline.multi-step.test.ts` — hits
 * Postgres via testcontainers, so neither `unit/` nor `integration/` fits.
 */
import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createAppContext, type AppContext } from "@/lib/di";
import { Result } from "@/lib/result";
import { createProject } from "@/projects/project/application/create-project";
import { upsertStepDefinition } from "@/pipeline-definitions/step-definition/application/upsert-step-definition";
import { createPipelineGraph } from "@/pipeline-definitions/pipeline-graph/application/create-pipeline-graph";
import { createPipelineRun } from "@/pipeline-executions/pipeline-run/application/create-pipeline-run";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import { ensureDemoFlagshipWorkItem } from "@/demo-project/application/ensure-demo-flagship-pipeline-definition";
import { pruneRetiredDemoPipelines } from "@/demo-project/application/prune-retired-demo-pipelines";
import { RETIRED_DEMO_PIPELINE_KEYS } from "@/demo-project/application/triage-and-investigate-pipeline-fixture";
import { COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY } from "@/demo-project/application/seed-demo-coupon-double-apply-flagship";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { fixedTimeProvider, serialTest } from "tests/utils";

/** The retired key the coupon flagship's pre-merge router ran under. */
const RETIRED_ROUTER_KEY = "intake_router";

let appContext: AppContext;
let projectId: UuidV7;
let userAuthz: UserAuthorizationService;

/**
 * Recreates just enough of the pre-merge state to prune: a chain-shaped
 * pipeline under a retired key, and a real execution of it for the real
 * coupon flagship work item. Deliberately does NOT drive the execution — the
 * prune deletes runs regardless of status, and a queued run is the cheapest
 * one to make.
 */
const seedRetiredPipelineWithExecution = async (): Promise<{
  pipelineGraphId: UuidV7;
  executionId: string;
}> => {
  const workItemId = await ensureDemoFlagshipWorkItem(
    appContext,
    projectId,
    userAuthz,
    {
      platformKey: COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
      title: "Applying a coupon twice crashes the checkout page",
      description: "Pre-merge state for the prune's coverage.",
      daysAgo: 0,
    },
  );

  const stepDefinition = await upsertStepDefinition(
    {
      projectId,
      key: `${RETIRED_ROUTER_KEY}_assess-intake-quality`,
      name: "Assess Intake Quality",
      description: "Pre-merge router step",
      prompt: "Judge whether this ticket is clear enough to act on.",
      version: 1,
      kind: "user_defined",
      environment: null,
      inputSchemaJson: { type: "object" },
      resultSchemaJson: { type: "object" },
      opencodeMcpJson: null,
      healthChecksJson: null,
      status: "active",
    },
    {
      userAuthz,
      stepDefinitionRepo: appContext.stepDefinitionRepo,
      taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
      environmentRepo: appContext.environmentRepo,
      timeProvider: appContext.timeProvider,
    },
  );

  const pipeline = Result.unwrap(
    await createPipelineGraph(
      {
        projectId,
        key: RETIRED_ROUTER_KEY,
        name: "Intake Router",
        document: {
          schemaVersion: 1,
          key: RETIRED_ROUTER_KEY,
          start: { to: "assess-intake-quality" },
          nodes: {
            "assess-intake-quality": {
              kind: "step",
              step: stepDefinition.key,
              next: {
                routes: [{ to: "done" }],
              },
            },
            done: { kind: "succeed" },
          },
        },
      },
      {
        userAuthz,
        pipelineGraphRepo: appContext.pipelineGraphRepo,
        pipelineGraphVersionRepo: appContext.pipelineGraphVersionRepo,
        stepDefinitionRepo: appContext.stepDefinitionRepo,
        timeProvider: appContext.timeProvider,
        analytics: appContext.analytics,
        via: "push",
      },
    ),
  );

  const execution = Result.unwrap(
    await createPipelineRun(
      {
        projectId,
        workItemId,
        pipelineDefinitionId: parseUuidV7(pipeline.id),
      },
      {
        ...appContext,
        userAuthz,
        triggeredBy: "actor",
      },
    ),
  );

  return {
    pipelineGraphId: parseUuidV7(pipeline.id),
    executionId: execution.id,
  };
};

beforeAll(async () => {
  appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-08-16T12:00:00.000Z")),
    objectStore: null,
  });
  const owner = await createTestUserAndSession({
    email: `demo-prune-retired-pipelines-${crypto.randomUUID()}@example.com`,
  });
  userAuthz = appContext.createUserAuthorizationService(
    parseUuidV7(owner.userId),
  );
  const project = await createProject(
    {
      name: `Demo Prune Retired Pipelines ${crypto.randomUUID()}`,
      description: "Throwaway project for the retired-pipeline pruner",
      gitUrl: "https://github.com/example/test-project.git",
      source: "manual",
    },
    {
      userAuthz,
      projectRepo: appContext.projectRepo,
      orgRepo: appContext.orgRepo,
      timeProvider: appContext.timeProvider,
      domainEventDispatcher: appContext.domainEventDispatcher,
      analytics: appContext.analytics,
    },
  );
  projectId = parseUuidV7(project.id);
});

describe("pruneRetiredDemoPipelines", () => {
  serialTest(
    "deletes a retired pipeline's executions and archives it out of the project",
    async () => {
      const { pipelineGraphId } = await seedRetiredPipelineWithExecution();

      await pruneRetiredDemoPipelines(appContext, projectId);

      const handle =
        await appContext.pipelineGraphRepo.loadHandle(pipelineGraphId);
      expect(handle?.isArchived).toBe(true);

      const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
        projectId,
        "scarn",
        COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
      );
      if (!workItem) {
        throw new Error("Expected the flagship work item to still exist");
      }
      expect(
        await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
          workItem.id,
          pipelineGraphId,
        ),
      ).toHaveLength(0);

      // The work item itself is NOT retired — it is still a live flagship,
      // it just runs a different pipeline now.
      const listed =
        await appContext.pipelineGraphRepo.listByProjectId(projectId);
      expect(listed.map((resolved) => resolved.handle.key)).not.toContain(
        RETIRED_ROUTER_KEY,
      );
    },
    30_000,
  );

  serialTest("is idempotent and safe with nothing to prune", async () => {
    await pruneRetiredDemoPipelines(appContext, projectId);
    await pruneRetiredDemoPipelines(appContext, projectId);

    const listed =
      await appContext.pipelineGraphRepo.listByProjectId(projectId);
    for (const retiredKey of RETIRED_DEMO_PIPELINE_KEYS) {
      expect(listed.map((resolved) => resolved.handle.key)).not.toContain(
        retiredKey,
      );
    }
  });
});
