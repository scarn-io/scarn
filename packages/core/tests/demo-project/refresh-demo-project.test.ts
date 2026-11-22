/**
 * DB-backed coverage for `refreshDemoProject`, which composes the already-
 * covered `resetDemoExecutions` (see `reset-demo-executions.ts`'s own doc
 * comment) and `seedDemoProject` (covered end to end by
 * `seed-demo-pipeline.multi-step.test.ts` and the flagship tests in this
 * directory). This file only needs to prove the composition itself: the
 * returned `projectPath` is stable across a refresh, a refresh actually
 * produces fresh tasks (not a no-op), and back-to-back refreshes
 * don't throw.
 *
 * Unlike the other tests in this directory, this one operates on the real
 * singleton demo account/project (fixed slugs from `demo-account.ts`) rather
 * than a throwaway project, because `refreshDemoProject` has nothing to
 * refresh without it. The shared Postgres testcontainer is reused across
 * every test file in the run, so another file may have already seeded the
 * singleton demo project by the time this one runs (or vice versa) — both
 * `resetDemoExecutions` and `seedDemoProject` are designed to be idempotent
 * and safe against that (see their own doc comments), which this file relies
 * on rather than re-proves.
 *
 * Placement: same reasoning as `seed-demo-pipeline.multi-step.test.ts` — hits
 * Postgres via testcontainers, so neither `unit/` nor `integration/` fits.
 */
import { afterEach, beforeAll, describe, expect } from "bun:test";
import pg from "pg";
import { createAppContext, type AppContext } from "@/lib/di";
import { Result } from "@/lib/result";
import { getPipelineRun } from "@/pipeline-executions/pipeline-run/application/get-pipeline-run";
import {
  DEMO_ACCOUNT_USER_ID,
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@/demo-project/demo-account";
import { seedDemoProject } from "@/demo-project/application/seed-demo-project";
import {
  DEMO_PROJECT_REFRESH_LOCK_KEY,
  refreshDemoProject,
} from "@/demo-project/application/refresh-demo-project";
import { fixedTimeProvider, serialTest } from "tests/utils";
import { holdDemoProjectTestLock } from "./demo-project-test-lock";

holdDemoProjectTestLock();

/**
 * Two `feature_qa` work items whose fixtures produce a real execution
 * (`failed`/`succeeded`, not `notStarted`/`queued`) — see
 * `demo-project-fixtures.ts`. Using two rather than one makes the "entirely
 * disjoint" assertion below meaningful across more than a single step
 * execution.
 */
const FEATURE_QA_EXECUTED_PLATFORM_KEYS = [
  "demo-feature-qa-2",
  "demo-feature-qa-3",
];

let appContext: AppContext;

/**
 * All task ids currently seeded for the two fixture work items
 * above, read back through the same `getPipelineExecution` read model
 * the app/API uses (following `seed-demo-pipeline.multi-step.test.ts`'s
 * pattern) rather than a repo-internal listing.
 */
const loadDemoTaskIds = async (): Promise<Set<string>> => {
  const org = await appContext.orgRepo.loadPersonalOrgByOwnerUsername(
    DEMO_ACCOUNT_USERNAME,
  );
  if (!org) {
    throw new Error("Expected the demo account's personal org to be seeded");
  }
  const project = await appContext.projectRepo.loadByOrgAndSlug(
    org.id,
    DEMO_PROJECT_SLUG,
  );
  if (!project) {
    throw new Error("Expected the demo project to be seeded");
  }
  const userAuthz =
    appContext.createUserAuthorizationService(DEMO_ACCOUNT_USER_ID);

  const handle = await appContext.pipelineGraphRepo.findHandleByKey(
    project.id,
    "feature_qa",
  );
  if (!handle) {
    throw new Error("Expected the feature_qa pipeline definition to be seeded");
  }

  const taskIds = new Set<string>();
  for (const platformKey of FEATURE_QA_EXECUTED_PLATFORM_KEYS) {
    const workItem = await appContext.workItemRepo.loadByPlatformIdentity(
      project.id,
      "scarn",
      platformKey,
    );
    if (!workItem) {
      throw new Error(`Expected work item ${platformKey} to be seeded`);
    }
    const executions =
      await appContext.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
        workItem.id,
        handle.id,
      );
    const execution = executions[0];
    if (executions.length !== 1 || !execution) {
      throw new Error(
        `Expected exactly one execution for ${platformKey}, got ${String(executions.length)}`,
      );
    }
    const full = Result.unwrap(
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
    for (const visit of full.visits) {
      for (const task of visit.tasks) {
        taskIds.add(task.taskId);
      }
    }
  }
  return taskIds;
};

/**
 * `objectStore: null` here for the same reason
 * `seed-demo-pipeline.multi-step.test.ts` uses it: log/artifact archival
 * degrades gracefully without an object store, and this file's assertions
 * only care about task identity, not archived content.
 */
beforeAll(() => {
  appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-08-17T12:00:00.000Z")),
    objectStore: null,
  });
});

describe("refreshDemoProject", () => {
  serialTest(
    "returns the same projectPath and replaces the demo project's tasks",
    async () => {
      // Ensure the singleton demo project exists before capturing a
      // baseline — safe even if another test file already seeded it.
      await seedDemoProject(appContext);
      const before = await loadDemoTaskIds();
      expect(before.size).toBeGreaterThan(0);

      const result = await refreshDemoProject(appContext);

      expect(result.projectPath).toBe(
        `/${DEMO_ACCOUNT_USERNAME}/${DEMO_PROJECT_SLUG}`,
      );

      const after = await loadDemoTaskIds();
      expect(after.size).toBeGreaterThan(0);
      // Fresh tasks on every refresh: the "after" set must share
      // no ids with "before" (archive keys derive from taskId, see
      // `seed-demo-execution.ts`), which would fail if `refreshDemoProject`
      // were a no-op re-seed.
      for (const id of after) {
        expect(before.has(id)).toBe(false);
      }
    },
    60_000,
  );

  serialTest(
    "is safe to call twice in a row",
    async () => {
      await refreshDemoProject(appContext);
      await refreshDemoProject(appContext);
    },
    60_000,
  );

  describe("when another refresh already holds the advisory lock", () => {
    /**
     * A separate, raw `pg` connection (not `getDb()`'s pool, which is
     * meant to hand out transient connections) used to hold
     * `DEMO_PROJECT_REFRESH_LOCK_KEY` with the SESSION-scoped
     * `pg_advisory_lock` — not `_xact_` — so the test controls exactly when
     * the lock is released, independent of any transaction lifecycle.
     */
    let lockHolder: pg.Client | undefined;

    afterEach(async () => {
      // Guards against a failed assertion above leaking a held lock into
      // later tests in the same run: always release + close, even if this
      // test never got as far as acquiring the lock.
      if (lockHolder) {
        await lockHolder.query("select pg_advisory_unlock($1)", [
          DEMO_PROJECT_REFRESH_LOCK_KEY,
        ]);
        await lockHolder.end();
        lockHolder = undefined;
      }
    });

    serialTest(
      "short-circuits to the fallback path without touching the demo project's tasks",
      async () => {
        await seedDemoProject(appContext);
        const before = await loadDemoTaskIds();
        expect(before.size).toBeGreaterThan(0);

        const databaseUrl = process.env["DATABASE_URL"];
        if (!databaseUrl) {
          throw new Error(
            "Expected DATABASE_URL to be set by the test db setup",
          );
        }
        lockHolder = new pg.Client({ connectionString: databaseUrl });
        await lockHolder.connect();
        await lockHolder.query("select pg_advisory_lock($1)", [
          DEMO_PROJECT_REFRESH_LOCK_KEY,
        ]);

        const result = await refreshDemoProject(appContext);

        expect(result.projectPath).toBe(
          `/${DEMO_ACCOUNT_USERNAME}/${DEMO_PROJECT_SLUG}`,
        );

        const after = await loadDemoTaskIds();
        expect(after).toEqual(before);
      },
      60_000,
    );
  });
});
