/**
 * DB-backed coverage for the `Ask the Reporter` demo pipeline
 * (`seed-demo-needs-input.ts`): one run parked on a reply wait, and one that
 * was answered and resumed.
 *
 * Placement: same reasoning as `seed-demo-pipeline.multi-step.test.ts`. It
 * hits Postgres via testcontainers, so neither `unit/` nor `integration/`
 * fits.
 */
import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { createAppContext, type AppContext } from "@/lib/di";
import { Result } from "@/lib/result";
import { createProject } from "@/projects/project/application/create-project";
import { getPipelineRun } from "@/pipeline-executions/pipeline-run/application/get-pipeline-run";
import type { PipelineExecutionContract } from "@/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import type { UserAuthorizationService } from "@/access/authorization/application/user-authorization-service";
import {
  NEEDS_INPUT_ANSWERED_WORK_ITEM_PLATFORM_KEY,
  NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY,
  ensureDemoNeedsInput,
  resetDemoNeedsInput,
} from "@/demo-project/application/seed-demo-needs-input";
import {
  DEMO_TEAMMATE_REPLY,
  NEEDS_INPUT_PIPELINE_KEY,
} from "@/demo-project/application/needs-input-pipeline-fixture";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { fixedTimeProvider, serialTest } from "tests/utils";

let appContext: AppContext;
let projectId: UuidV7;
let userAuthz: UserAuthorizationService;

const loadWorkItem = async (platformKey: string) => {
  const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
    projectId,
    "scarn",
    platformKey,
  );
  if (!workItem) {
    throw new Error(`Expected work item ${platformKey} to be seeded`);
  }
  return workItem;
};

const listRuns = async (platformKey: string) => {
  const handle = await appContext.pipelineGraphRepo.findHandleByKey(
    projectId,
    NEEDS_INPUT_PIPELINE_KEY,
  );
  if (!handle) {
    throw new Error(`Expected pipeline ${NEEDS_INPUT_PIPELINE_KEY}`);
  }
  return await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
    (await loadWorkItem(platformKey)).id,
    handle.id,
  );
};

const loadRun = async (
  platformKey: string,
): Promise<PipelineExecutionContract> => {
  const runs = await listRuns(platformKey);
  const run = runs[0];
  if (runs.length !== 1 || !run) {
    throw new Error(`Expected one run, got ${String(runs.length)}`);
  }
  return Result.unwrap(
    await getPipelineRun(run.id, {
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

const loadComments = async (platformKey: string) =>
  await appContext.workItemCommentRepo.loadByWorkItemId(
    parseUuidV7((await loadWorkItem(platformKey)).id),
  );

beforeAll(
  async () => {
    appContext = createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-10-25T12:00:00.000Z")),
      objectStore: null,
    });
    const owner = await createTestUserAndSession({
      email: `demo-seed-needs-input-${crypto.randomUUID()}@example.com`,
    });
    userAuthz = appContext.createUserAuthorizationService(
      parseUuidV7(owner.userId),
    );
    const project = await createProject(
      {
        name: `Demo Seed Needs Input ${crypto.randomUUID()}`,
        description: "Throwaway project for the needs-input demo's coverage",
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

    await ensureDemoNeedsInput(appContext, projectId, userAuthz);
  },
  { timeout: 20_000 },
);

describe("seeding the Ask the Reporter demo pipeline", () => {
  serialTest(
    "parks the thin ticket's run on an open question comment",
    async () => {
      const run = await loadRun(NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY);

      expect(run.status).toBe("waiting");
      expect(run.waitingFor).toBe("reply");
      expect(run.visits.map((visit) => visit.nodeId)).toEqual([
        "assess-report",
        "ask-for-details",
      ]);
      const wait = run.visits[1];
      expect(wait?.waitFor).toBe("reply");
      expect(wait?.questions.map((question) => question.status)).toEqual([
        "open",
      ]);

      const [question] = await loadComments(
        NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY,
      );
      expect(question?.id as string | undefined).toBe(
        wait?.questions[0]?.commentId,
      );
      expect(question?.authorKind).toBe("agent");
      expect(question?.body).toContain("Which export is broken: CSV or PDF?");
    },
  );

  serialTest(
    "resumes the answered ticket's run and reads the reply",
    async () => {
      const run = await loadRun(NEEDS_INPUT_ANSWERED_WORK_ITEM_PLATFORM_KEY);

      expect(run.status).toBe("succeeded");
      expect(run.endNodeId).toBe("done");
      expect(run.visits.map((visit) => visit.nodeId)).toEqual([
        "assess-report",
        "ask-for-details",
        "assess-report",
        "done",
      ]);
      expect(run.visits[1]?.result).toMatchObject({
        replied: true,
        body: DEMO_TEAMMATE_REPLY,
      });
      expect(run.visits[1]?.questions[0]?.status).toBe("answered");

      const comments = await loadComments(
        NEEDS_INPUT_ANSWERED_WORK_ITEM_PLATFORM_KEY,
      );
      expect(comments.map((comment) => comment.body)).toContain(
        DEMO_TEAMMATE_REPLY,
      );
    },
  );

  serialTest("doesn't seed a second run on a re-seed", async () => {
    await ensureDemoNeedsInput(appContext, projectId, userAuthz);

    expect(
      await listRuns(NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY),
    ).toHaveLength(1);
    expect(
      await loadComments(NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY),
    ).toHaveLength(1);
  });

  serialTest("re-seeds one question per work item after a reset", async () => {
    await resetDemoNeedsInput(appContext, projectId);
    await ensureDemoNeedsInput(appContext, projectId, userAuthz);

    expect(
      await loadComments(NEEDS_INPUT_WAITING_WORK_ITEM_PLATFORM_KEY),
    ).toHaveLength(1);
    expect(
      await loadComments(NEEDS_INPUT_ANSWERED_WORK_ITEM_PLATFORM_KEY),
    ).toHaveLength(2);
  });
});
