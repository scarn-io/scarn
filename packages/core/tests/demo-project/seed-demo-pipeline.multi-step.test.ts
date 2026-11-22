/**
 * DB-backed coverage for the demo seed's multi-step drive loop
 * (`ensureDemoWorkItemExecution`) via the `feature_qa` fixture. The routed
 * two-pipeline flagship (`Intake Router` -> `Browser Repro & Investigate`,
 * which replaced the old two-step `bug_triage` pipeline) has its own coverage
 * in `seed-demo-coupon-double-apply-flagship.test.ts` — it's driven by a
 * different orchestration function (`ensureRoutedDemoPipelineExecution`), not
 * this one.
 *
 * Placement: this file is deliberately in neither `unit/` (it hits Postgres via
 * testcontainers, so it is not a unit test) nor `integration/` (those must
 * exercise the public API client per `docs/testing.md`, and the demo seed has no
 * HTTP surface — it is a script entry point, `apps/api/src/seed-demo-project.ts`).
 * `bun test` picks it up either way.
 */
import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createAppContext, type AppContext } from "@/lib/di";
import { Result } from "@/lib/result";
import { createProject } from "@/projects/project/application/create-project";
import { getPipelineRun } from "@/pipeline-executions/pipeline-run/application/get-pipeline-run";
import type { PipelineExecutionContract } from "@/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import { DEMO_PIPELINE_FIXTURES } from "@/demo-project/demo-project-fixtures";
import { ensureDemoPipeline } from "@/demo-project/application/seed-demo-pipeline";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { fixedTimeProvider, serialTest } from "tests/utils";

const fixtureByKey = (key: string) => {
  const fixture = DEMO_PIPELINE_FIXTURES.find((item) => item.key === key);
  if (!fixture) {
    throw new Error(`Expected a demo pipeline fixture keyed ${key}`);
  }
  return fixture;
};

let appContext: AppContext;
let projectId: UuidV7;
let userAuthz: UserAuthorizationService;

/**
 * Seeds the real `feature_qa` fixture into a throwaway project of its own. A
 * fresh project (rather than the singleton demo account's) keeps the
 * fixture's `platformKey`/pipeline-key natural keys unclaimed, so the seed's
 * "ensure" short-circuits never skip the work under test — the Postgres
 * container is reused across runs and is not reset between them.
 */
beforeAll(
  async () => {
    appContext = createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-08-12T12:00:00.000Z")),
      objectStore: null,
    });
    const owner = await createTestUserAndSession({
      email: `demo-seed-multi-step-${crypto.randomUUID()}@example.com`,
    });
    userAuthz = appContext.createUserAuthorizationService(
      parseUuidV7(owner.userId),
    );
    const project = await createProject(
      {
        name: `Demo Seed Multi Step ${crypto.randomUUID()}`,
        description:
          "Throwaway project for the demo seed's multi-step coverage",
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

    await ensureDemoPipeline(
      appContext,
      projectId,
      userAuthz,
      fixtureByKey("feature_qa"),
    );
  },
  { timeout: 20_000 },
);

const loadExecutions = async (pipelineKey: string, platformKey: string) => {
  const handle = await appContext.pipelineGraphRepo.findHandleByKey(
    projectId,
    pipelineKey,
  );
  if (!handle) {
    throw new Error(`Expected pipeline definition ${pipelineKey} to be seeded`);
  }
  const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
    projectId,
    "scarn",
    platformKey,
  );
  if (!workItem) {
    throw new Error(`Expected work item ${platformKey} to be seeded`);
  }
  return await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
    workItem.id,
    handle.id,
  );
};

/** The single seeded execution for a fixture work item, as a read contract. */
const loadExecution = async (
  pipelineKey: string,
  platformKey: string,
): Promise<PipelineExecutionContract> => {
  const executions = await loadExecutions(pipelineKey, platformKey);
  const execution = executions[0];
  if (executions.length !== 1 || !execution) {
    throw new Error(
      `Expected exactly one execution for ${platformKey}, got ${String(executions.length)}`,
    );
  }
  return Result.unwrap(
    await getPipelineRun(execution.id, {
      userAuthz,
      pipelineRunRepo: appContext.pipelineRunRepo,
      pipelineGraphVersionRepo: appContext.pipelineGraphVersionRepo,
      nodeVisitQuestionRepo: appContext.nodeVisitQuestionRepo,
      workItemTitleReader: appContext.workItemTitleReader,
      usernameReader: appContext.usernameReader,
      automationRepo: appContext.automationRepo,
      taskRunRepo: appContext.taskRunRepo,
      timeProvider: appContext.timeProvider,
    }),
  );
};

const stepVisits = (execution: PipelineExecutionContract) =>
  execution.visits.filter((visit) => visit.nodeKind === "step");

describe("seeding the multi-step feature_qa demo pipeline", () => {
  serialTest(
    "seeds exactly one failed work item across the whole fixture set",
    () => {
      const failed = DEMO_PIPELINE_FIXTURES.flatMap((pipeline) =>
        pipeline.workItems.filter((item) => item.outcome === "failed"),
      );
      expect(failed.map((item) => item.platformKey)).toEqual([
        "demo-feature-qa-2",
      ]);
    },
  );

  serialTest(
    "stops the failed work item at the first step without queueing another",
    async () => {
      const execution = await loadExecution("feature_qa", "demo-feature-qa-2");
      const visits = stepVisits(execution);

      expect(visits).toHaveLength(1);
      expect(visits[0]?.nodeId).toBe("step");
      expect(visits[0]?.status).toBe("failed");
      expect(execution.status).toBe("failed");
      expect(execution.completedAt).not.toBeNull();
    },
  );

  serialTest(
    "creates no execution at all for a notStarted work item",
    async () => {
      expect(
        await loadExecutions("feature_qa", "demo-feature-qa-1"),
      ).toHaveLength(0);
    },
  );

  serialTest("leaves a queued fixture's execution unclaimed", async () => {
    const execution = await loadExecution("feature_qa", "demo-feature-qa-4");
    const visits = stepVisits(execution);

    expect(visits).toHaveLength(1);
    expect(visits[0]?.status).toBe("active");
    expect(visits[0]?.tasks.map((task) => task.status)).toEqual(["queued"]);
    expect(execution.status).toBe("queued");
    expect(execution.completedAt).toBeNull();
  });

  serialTest(
    "still drives a single-step pipeline to succeeded in exactly one pass",
    async () => {
      const execution = await loadExecution("feature_qa", "demo-feature-qa-3");
      const visits = stepVisits(execution);

      expect(visits).toHaveLength(1);
      expect(visits[0]?.nodeId).toBe("step");
      expect(visits[0]?.status).toBe("succeeded");
      expect(execution.status).toBe("succeeded");
      expect(execution.endNodeId).toBe("done");
    },
  );
});
