/**
 * DB-backed coverage for the coupon-double-apply flagship
 * (`ensureDemoFlagshipExecution` via
 * `seed-demo-coupon-double-apply-flagship.ts`): one real run of the
 * graph-shaped `Triage & Investigate` pipeline document, whose
 * `classify-and-label-impact` step branches on its real captured `routeKey`
 * (through the engine's own `next` evaluation rather than a fabrication) and
 * takes the browser-repro branch.
 *
 * Placement: same reasoning as `seed-demo-pipeline.multi-step.test.ts` — hits
 * Postgres via testcontainers, so neither `unit/` nor `integration/` fits.
 */
import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { WorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createAppContext, type AppContext } from "@/lib/di";
import { Result } from "@/lib/result";
import { createProject } from "@/projects/project/application/create-project";
import { getPipelineRun } from "@/pipeline-executions/pipeline-run/application/get-pipeline-run";
import type { PipelineExecutionContract } from "@/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import {
  COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
  ensureDemoCouponDoubleApplyFlagship,
} from "@/demo-project/application/seed-demo-coupon-double-apply-flagship";
import { TRIAGE_AND_INVESTIGATE_PIPELINE_KEY } from "@/demo-project/application/triage-and-investigate-pipeline-fixture";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { fixedTimeProvider, serialTest } from "tests/utils";

let appContext: AppContext;
let projectId: UuidV7;
let userAuthz: UserAuthorizationService;
let workItemId: WorkItemId;

const listExecutions = async () => {
  const handle = await appContext.pipelineGraphRepo.findHandleByKey(
    projectId,
    TRIAGE_AND_INVESTIGATE_PIPELINE_KEY,
  );
  if (!handle) {
    throw new Error(
      `Expected pipeline definition ${TRIAGE_AND_INVESTIGATE_PIPELINE_KEY} to be seeded`,
    );
  }
  return await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
    workItemId,
    handle.id,
  );
};

const loadExecution = async (): Promise<PipelineExecutionContract> => {
  const executions = await listExecutions();
  const execution = executions[0];
  if (executions.length !== 1 || !execution) {
    throw new Error(
      `Expected exactly one flagship execution, got ${String(executions.length)}`,
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

const visitFor = (execution: PipelineExecutionContract, nodeId: string) => {
  const visit = execution.visits.find((item) => item.nodeId === nodeId);
  if (!visit) {
    throw new Error(`Expected a visit to ${nodeId}`);
  }
  return visit;
};

/**
 * Seeds the flagship into a throwaway project. `objectStore` is a real
 * (in-memory) store rather than `null` here on purpose — unlike the
 * `feature_qa` multi-step test, this flagship's whole point is to exercise
 * the artifact-write path for `reproduce-in-browser`.
 */
beforeAll(
  async () => {
    appContext = createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-08-16T12:00:00.000Z")),
      objectStore: new InMemoryObjectStore(),
    });
    const owner = await createTestUserAndSession({
      email: `demo-seed-flagship-${crypto.randomUUID()}@example.com`,
    });
    userAuthz = appContext.createUserAuthorizationService(
      parseUuidV7(owner.userId),
    );
    const project = await createProject(
      {
        name: `Demo Seed Flagship ${crypto.randomUUID()}`,
        description: "Throwaway project for the flagship's coverage",
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

    await ensureDemoCouponDoubleApplyFlagship(appContext, projectId, userAuthz);

    const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
      projectId,
      "scarn",
      COUPON_DOUBLE_APPLY_WORK_ITEM_PLATFORM_KEY,
    );
    if (!workItem) {
      throw new Error("Expected the flagship's work item to be seeded");
    }
    workItemId = workItem.id;
  },
  { timeout: 20_000 },
);

describe("seeding the coupon-double-apply flagship", () => {
  serialTest(
    "drives intake, classification and the browser-repro branch in one execution",
    async () => {
      const execution = await loadExecution();
      const visits = stepVisits(execution);

      expect(visits.map((visit) => visit.nodeId)).toEqual([
        "assess-intake-quality",
        "classify-and-label-impact",
        "reproduce-in-browser",
        "investigate-root-cause",
      ]);
      expect(visits.map((visit) => visit.status)).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
      expect(execution.status).toBe("succeeded");
      expect(execution.endNodeId).toBe("done");
    },
  );

  serialTest(
    "never queues the perf-bisect branch classification didn't select",
    async () => {
      const nodeIds = (await loadExecution()).visits.map(
        (visit) => visit.nodeId,
      );

      expect(nodeIds).not.toContain("confirm-perf-regression");
      expect(nodeIds).not.toContain("bisect-perf-regression");
    },
  );

  serialTest(
    "records classification's real decision against the captured routeKey",
    async () => {
      const execution = await loadExecution();
      const classify = visitFor(execution, "classify-and-label-impact");

      // Route 1 — `perf-bisect` is index 0.
      expect(classify.routing).toMatchObject({
        taken: [{ kind: "route", index: 1 }],
      });
      expect(classify.result).toMatchObject({
        routeKey: "browser-repro-investigate",
      });
      expect(visitFor(execution, "reproduce-in-browser").fromVisitId).toBe(
        classify.id,
      );
    },
  );

  serialTest(
    "passes the intake gate on Assess Intake Quality's own scores",
    async () => {
      const assess = visitFor(await loadExecution(), "assess-intake-quality");
      expect(assess.routing).toMatchObject({
        taken: [{ kind: "route", index: 0 }],
      });
      const scores = assess.result as {
        observedBehaviorScore?: unknown;
        expectedBehaviorScore?: unknown;
      } | null;
      expect(typeof scores?.observedBehaviorScore).toBe("number");
      expect(typeof scores?.expectedBehaviorScore).toBe("number");
    },
  );

  serialTest(
    "attaches the real trace + screenshot to Reproduce In Browser only",
    async () => {
      const execution = await loadExecution();
      const reproduceTaskId = visitFor(
        execution,
        "reproduce-in-browser",
      ).resultTaskId;
      const investigateTaskId = visitFor(
        execution,
        "investigate-root-cause",
      ).resultTaskId;
      if (!reproduceTaskId || !investigateTaskId) {
        throw new Error("Expected both step visits to have a result task");
      }

      const reproduceArtifacts =
        await appContext.artifactRepo.listByTask(reproduceTaskId);
      const investigateArtifacts =
        await appContext.artifactRepo.listByTask(investigateTaskId);

      expect(
        reproduceArtifacts.map((artifact) => artifact.kind).sort(),
      ).toEqual(["generic", "playwright-trace"]);
      // The real captured run's `investigate-root-cause` picked up copies of
      // Reproduce's artifacts due to a worker bug — this flagship does not
      // replay that bug.
      expect(investigateArtifacts).toHaveLength(0);
    },
  );

  serialTest(
    "creates the real notification from Reproduce In Browser's own result",
    async () => {
      const notifications = await appContext.userNotificationRepo.list({
        projectId,
        viewerUserId: userAuthz.actorId,
        workItemId: parseUuidV7(workItemId),
      });
      expect(
        notifications.some(
          (notification) =>
            notification.title ===
            "Browser repro captured for coupon double-apply failure",
        ),
      ).toBe(true);
    },
  );

  serialTest(
    "is idempotent: re-running does not create a second execution",
    async () => {
      await ensureDemoCouponDoubleApplyFlagship(
        appContext,
        projectId,
        userAuthz,
      );

      expect(await listExecutions()).toHaveLength(1);
    },
  );
});
