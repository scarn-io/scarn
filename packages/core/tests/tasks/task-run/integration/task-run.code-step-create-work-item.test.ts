import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK } from "@/tasks/task-run/contracts/task-run-work-item-contracts";
import type { Grant } from "@/tasks/task/domain/grants";
import { DrizzleWorkItemRepo } from "@/work-items/work-item/infra/drizzle-work-item-repo";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  CODE_STEP_NOW,
  expectGrantMissing,
  importGrants,
  importItem,
  keyPrefix,
  startClaimedScheduledRun,
} from "./task-run-code-step-test-support";
import type { Claim } from "./task-run-create-work-item-test-support";

/**
 * A code step's single creates (`POST /task-runs/:id/work-item-creates`),
 * checked like its imports: the `create` grant's `keyPrefix` and labels, a
 * miss reported as `WORK_ITEM_GRANT_MISSING`, and no per-Task cap.
 */
describe("task run code-step work item creates", () => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(CODE_STEP_NOW),
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  const workItemRepo = new DrizzleWorkItemRepo();
  let projectId: UuidV7 | undefined;
  let ownerUserId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-run-code-step-creates-${crypto.randomUUID()}@example.com`,
    });
    ownerUserId = parseUuidV7(owner.userId);
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Run Code Step Creates Project",
          description: "Project for code-step create tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!projectId || !ownerUserId) {
      throw new Error("Expected setup to complete");
    }
    return { projectId, ownerUserId };
  };

  const startClaimedRun = async (grants: Grant[]) =>
    await startClaimedScheduledRun(appContext, {
      projectId: requireSetup().projectId,
      claimedByUserId: requireSetup().ownerUserId,
      grants,
    });

  const create = async (
    claim: Claim,
    platformKey: string,
    extra: { labels?: string[]; scope?: "children" | "project" } = {},
  ) =>
    await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-creates"
    ].post({
      claimToken: claim.claimToken,
      workItemId: createUuidV7(),
      ...(extra.scope === "children"
        ? { scope: "children" as const }
        : { scope: "project" as const, platformKey }),
      title: `Ticket ${platformKey}`,
      description: "Created by the step.",
      ...(extra.labels ? { labels: extra.labels } : {}),
    });

  const load = async (platformKey: string) =>
    await workItemRepo.loadByPlatformIdentity(
      requireSetup().projectId,
      "custom",
      platformKey,
    );

  concurrentTest("creates a key under the grant's keyPrefix", async () => {
    const p = keyPrefix();
    const claim = await startClaimedRun(importGrants(p));

    const response = await create(claim, `${p}1`, { labels: ["imported"] });

    expect(response.status).toBe(201);
    expect(await load(`${p}1`)).toMatchObject({
      labels: ["imported"],
      spawnedByTaskId: claim.taskId,
    });
  });

  concurrentTest(
    "refuses a key outside the grant's keyPrefix with WORK_ITEM_GRANT_MISSING",
    async () => {
      const p = keyPrefix();
      const claim = await startClaimedRun(importGrants(p));

      expectGrantMissing(
        await create(claim, `other-${p}1`),
        "no create grant on project covering that key",
      );
      expect(await load(`other-${p}1`)).toBeNull();
    },
  );

  concurrentTest(
    "refuses a label the grant doesn't cover with WORK_ITEM_GRANT_MISSING",
    async () => {
      const p = keyPrefix();
      const claim = await startClaimedRun(importGrants(p));

      expectGrantMissing(
        await create(claim, `${p}1`, { labels: ["urgent"] }),
        "urgent",
      );
      expect(await load(`${p}1`)).toBeNull();
    },
  );

  concurrentTest(
    "refuses a children create with WORK_ITEM_GRANT_MISSING",
    async () => {
      const claim = await startClaimedRun(importGrants());

      expectGrantMissing(
        await create(claim, `${keyPrefix()}1`, { scope: "children" }),
      );
    },
  );

  concurrentTest(
    "is not capped per Task, unlike an agent's project creates",
    async () => {
      const p = keyPrefix();
      const claim = await startClaimedRun(importGrants(p));
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
          "work-item-upserts"
        ].post({
          claimToken: claim.claimToken,
          items: Array.from(
            { length: MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK },
            (_, index) =>
              importItem(
                `${p}seed-${String(index)}`,
                "2026-10-01T00:00:00.000Z",
              ),
          ),
        }),
      );

      const response = await create(claim, `${p}one-more`);

      expect(response.status).toBe(201);
    },
  );
});
