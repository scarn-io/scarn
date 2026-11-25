import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import type { Grant } from "@/tasks/task/domain/grants";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  CODE_STEP_NOW,
  expectGrantMissing,
  importGrants,
  importItem as item,
  keyPrefix as prefix,
  projectGrant,
  startClaimedScheduledRun,
  type ImportItem,
} from "./task-run-code-step-test-support";
import type { Claim } from "./task-run-create-work-item-test-support";

/** A code step's import cursor (`POST /task-runs/:id/work-item-source-cursor`). */
describe("task run code-step source cursor", () => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(CODE_STEP_NOW),
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  let projectId: UuidV7 | undefined;
  let ownerUserId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-run-code-step-cursor-${crypto.randomUUID()}@example.com`,
    });
    ownerUserId = parseUuidV7(owner.userId);
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Run Code Step Cursor Project",
          description: "Project for code-step import cursor tests",
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

  const startClaimedRun = async (grants: Grant[], claimedByUserId?: UuidV7) =>
    await startClaimedScheduledRun(appContext, {
      projectId: requireSetup().projectId,
      claimedByUserId: claimedByUserId ?? requireSetup().ownerUserId,
      grants,
    });

  const upsert = async (claim: Claim, items: ImportItem[]) =>
    await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-upserts"
    ].post({ claimToken: claim.claimToken, items });

  const cursor = async (
    claim: Claim,
    platform: ImportItem["platform"],
    keyPrefix: string,
  ) =>
    await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-source-cursor"
    ].post({ claimToken: claim.claimToken, platform, keyPrefix });

  const readMember = async () => {
    const member = await createTestUserAndSession({
      email: `task-run-code-step-reader-${crypto.randomUUID()}@example.com`,
    });
    const userId = parseUuidV7(member.userId);
    await getDb()
      .insert(projectMemberships)
      .values({ projectId: requireSetup().projectId, userId, role: "read" });
    return userId;
  };

  concurrentTest(
    "is the newest sourceUpdatedAt per platform and prefix, null for none",
    async () => {
      const p = prefix();
      const claim = await startClaimedRun(importGrants(p));
      await unwrapAsync(
        upsert(claim, [
          item(`${p}a/1`, "2026-10-01T00:00:00.000Z"),
          item(`${p}a/2`, "2026-10-03T00:00:00.000Z"),
          item(`${p}b/1`, "2026-10-02T00:00:00.000Z"),
          item(`${p}a/9`, "2026-10-09T00:00:00.000Z", { platform: "jira" }),
        ]),
      );

      expect((await cursor(claim, "custom", `${p}a/`)).data).toEqual({
        sourceUpdatedAt: "2026-10-03T00:00:00.000Z",
      });
      expect((await cursor(claim, "custom", `${p}b/`)).data).toEqual({
        sourceUpdatedAt: "2026-10-02T00:00:00.000Z",
      });
      expect((await cursor(claim, "custom", `${p}c/`)).data).toEqual({
        sourceUpdatedAt: null,
      });
      expect((await cursor(claim, "jira", `${p}a/`)).data).toEqual({
        sourceUpdatedAt: "2026-10-09T00:00:00.000Z",
      });
    },
  );

  concurrentTest("matches the prefix literally, not as a pattern", async () => {
    const p = `src-${crypto.randomUUID()}`;
    const claim = await startClaimedRun(importGrants(p));
    await unwrapAsync(
      upsert(claim, [item(`${p}-x`, "2026-10-01T00:00:00.000Z")]),
    );

    expect((await cursor(claim, "custom", `${p}_`)).data).toEqual({
      sourceUpdatedAt: null,
    });
    expect((await cursor(claim, "custom", `${p}%`)).data).toEqual({
      sourceUpdatedAt: null,
    });
    expect((await cursor(claim, "custom", `${p}-`)).data).toEqual({
      sourceUpdatedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  concurrentTest("a crash after page 2 resumes from page 2's max", async () => {
    const p = prefix();
    const page = (from: number, day: number) =>
      [0, 1].map((offset) =>
        item(
          `${p}${String(from + offset)}`,
          `2026-10-${String(day + offset).padStart(2, "0")}T00:00:00.000Z`,
        ),
      );
    const firstRun = await startClaimedRun(importGrants(p));
    await unwrapAsync(upsert(firstRun, page(1, 1)));
    await unwrapAsync(upsert(firstRun, page(3, 3)));

    const nextRun = await startClaimedRun(importGrants(p));

    expect((await cursor(nextRun, "custom", p)).data).toEqual({
      sourceUpdatedAt: "2026-10-04T00:00:00.000Z",
    });
  });

  concurrentTest("needs a read grant on project", async () => {
    const p = prefix();
    const claim = await startClaimedRun([
      projectGrant("create", { labels: ["imported"] }),
    ]);

    expectGrantMissing(
      await cursor(claim, "custom", p),
      "no read grant on project",
    );
  });

  concurrentTest("is allowed for a claiming user with only read", async () => {
    const claim = await startClaimedRun(
      [projectGrant("read")],
      await readMember(),
    );

    expect((await cursor(claim, "custom", prefix())).data).toEqual({
      sourceUpdatedAt: null,
    });
  });
});
