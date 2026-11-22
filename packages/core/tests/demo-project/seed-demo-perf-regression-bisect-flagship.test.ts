/**
 * DB-backed coverage for the perf-regression-bisect flagship
 * (`ensureDemoFlagshipExecution` via
 * `seed-demo-perf-regression-bisect-flagship.ts`): one real run of the SAME
 * `Triage & Investigate` pipeline the coupon-double-apply flagship drives,
 * taking the OTHER branch out of `classify-and-label-impact` on the strength
 * of its own real captured `routeKey`.
 *
 * Placement: same reasoning as `seed-demo-coupon-double-apply-flagship.test.ts`
 * — hits Postgres via testcontainers, so neither `unit/` nor `integration/`
 * fits.
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
import {
  PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY,
  ensureDemoPerfRegressionBisectFlagship,
} from "@/demo-project/application/seed-demo-perf-regression-bisect-flagship";
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

/** Seeds the flagship into a throwaway project. Neither of this flagship's
 * branch steps records an artifact, so (unlike the coupon flagship's test)
 * `objectStore` is explicitly `null` here rather than a real store — matches
 * `seed-demo-pipeline.multi-step.test.ts`'s non-artifact-bearing fixtures. */
beforeAll(
  async () => {
    appContext = createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-08-16T12:00:00.000Z")),
      objectStore: null,
    });
    const owner = await createTestUserAndSession({
      email: `demo-seed-perf-bisect-flagship-${crypto.randomUUID()}@example.com`,
    });
    userAuthz = appContext.createUserAuthorizationService(
      parseUuidV7(owner.userId),
    );
    const project = await createProject(
      {
        name: `Demo Seed Perf Bisect Flagship ${crypto.randomUUID()}`,
        description:
          "Throwaway project for the perf-bisect flagship's coverage",
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

    await ensureDemoPerfRegressionBisectFlagship(
      appContext,
      projectId,
      userAuthz,
    );

    const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
      projectId,
      "scarn",
      PERF_SEARCH_REGRESSION_WORK_ITEM_PLATFORM_KEY,
    );
    if (!workItem) {
      throw new Error("Expected the flagship's work item to be seeded");
    }
    workItemId = workItem.id;
  },
  { timeout: 20_000 },
);

describe("seeding the perf-regression-bisect flagship", () => {
  serialTest(
    "drives intake, classification and the perf-bisect branch in one execution",
    async () => {
      const execution = await loadExecution();
      const visits = stepVisits(execution);

      expect(visits.map((visit) => visit.nodeId)).toEqual([
        "assess-intake-quality",
        "classify-and-label-impact",
        "confirm-perf-regression",
        "bisect-perf-regression",
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
    "never queues the browser-repro branch classification didn't select",
    async () => {
      const nodeIds = (await loadExecution()).visits.map(
        (visit) => visit.nodeId,
      );

      expect(nodeIds).not.toContain("reproduce-in-browser");
      expect(nodeIds).not.toContain("investigate-root-cause");
    },
  );

  serialTest(
    "takes the other transition out of classification than the coupon flagship",
    async () => {
      const classify = visitFor(
        await loadExecution(),
        "classify-and-label-impact",
      );

      // Route 0 — `browser-repro-investigate` is index 1,
      // which is what the coupon flagship takes.
      expect(classify.routing).toMatchObject({
        taken: [{ kind: "route", index: 0 }],
      });
      expect(classify.result).toMatchObject({ routeKey: "perf-bisect" });
    },
  );

  serialTest(
    "confirms the regression with the real captured measurements, gating on regressionPct",
    async () => {
      const execution = await loadExecution();
      const confirm = visitFor(execution, "confirm-perf-regression");
      expect(confirm.routing).toMatchObject({
        taken: [{ kind: "route", index: 0 }],
      });
      expect(confirm.result).toMatchObject({
        regressionPct: 11725.311203319503,
      });
      expect(
        typeof visitFor(execution, "bisect-perf-regression").input[
          "endpointPath"
        ],
      ).toBe("string");
    },
  );

  serialTest(
    "does not leak the culprit commit's real author into the demo project",
    async () => {
      const bisect = visitFor(await loadExecution(), "bisect-perf-regression");
      expect(bisect.result).toMatchObject({
        culpritAuthor: "Unknown <redacted@example.com>",
      });
    },
  );

  serialTest(
    "is idempotent: re-running does not create a second execution",
    async () => {
      await ensureDemoPerfRegressionBisectFlagship(
        appContext,
        projectId,
        userAuthz,
      );

      expect(await listExecutions()).toHaveLength(1);
    },
  );
});
