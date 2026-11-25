import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { projectMemberships } from "@/lib/db/schema";
import type { Grant } from "@/tasks/task/domain/grants";
import { DrizzleWorkItemRepo } from "@/work-items/work-item/infra/drizzle-work-item-repo";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { RecordingWorkItemEvents } from "tests/work-items/work-item/integration/work-item-events-test-support";
import {
  CODE_STEP_NOW as NOW,
  expectGrantMissing,
  importGrants,
  importItem as item,
  keyPrefix as prefix,
  projectGrant,
  startClaimedScheduledRun,
  type ImportItem as Item,
} from "./task-run-code-step-test-support";
import type { Claim } from "./task-run-create-work-item-test-support";

/**
 * A code step's imports (`POST /task-runs/:id/work-item-upserts`).
 */
describe("task run code-step work items", () => {
  let recorder: RecordingWorkItemEvents | undefined;
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(NOW),
    workItemEvents: (inner) => (recorder = new RecordingWorkItemEvents(inner)),
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  const workItemRepo = new DrizzleWorkItemRepo();
  let projectId: UuidV7 | undefined;
  let ownerUserId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-run-code-step-work-items-${crypto.randomUUID()}@example.com`,
    });
    ownerUserId = parseUuidV7(owner.userId);
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Run Code Step Work Items Project",
          description: "Project for code-step import tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!projectId || !ownerUserId || !recorder) {
      throw new Error("Expected setup to complete");
    }
    return { projectId, ownerUserId, recorder };
  };

  /** A running run of a scheduled code Task with `grants`, claimed by the owner unless given. */
  const startClaimedRun = async (
    grants: Grant[],
    claimedByUserId?: UuidV7,
    kind: "code" | "agent" = "code",
  ) => {
    const { projectId, ownerUserId } = requireSetup();
    return await startClaimedScheduledRun(appContext, {
      projectId,
      claimedByUserId: claimedByUserId ?? ownerUserId,
      grants,
      kind,
    });
  };

  const upsert = async (claim: Claim, items: Item[]) =>
    await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-upserts"
    ].post({ claimToken: claim.claimToken, items });

  const load = async (platform: Item["platform"], platformKey: string) =>
    await workItemRepo.loadByPlatformIdentity(
      requireSetup().projectId,
      platform,
      platformKey,
    );

  const readMember = async () => {
    const { projectId } = requireSetup();
    const member = await createTestUserAndSession({
      email: `task-run-code-step-reader-${crypto.randomUUID()}@example.com`,
    });
    const userId = parseUuidV7(member.userId);
    await getDb()
      .insert(projectMemberships)
      .values({ projectId, userId, role: "read" });
    return userId;
  };

  concurrentTest(
    "creates new keys and updates existing ones, as the claiming user, spawned by the Task",
    async () => {
      const { projectId, ownerUserId } = requireSetup();
      const p = prefix();
      const claim = await startClaimedRun(importGrants(p));
      await unwrapAsync(
        upsert(claim, [item(`${p}1`, "2026-10-01T00:00:00.000Z")]),
      );

      const response = await upsert(claim, [
        item(`${p}1`, "2026-10-02T00:00:00.000Z", { title: "Renamed" }),
        item(`${p}2`, "2026-10-02T00:00:00.000Z", { labels: ["imported"] }),
      ]);

      expect(response.status).toBe(200);
      expect(response.data?.counts).toEqual({
        created: 1,
        updated: 1,
        unchanged: 0,
      });
      expect(response.data?.items.map((each) => each.outcome)).toEqual([
        "updated",
        "created",
      ]);
      expect(await load("custom", `${p}1`)).toMatchObject({
        title: "Renamed",
      });
      expect(await load("custom", `${p}2`)).toMatchObject({
        projectId,
        platform: "custom",
        labels: ["imported"],
        createdByUserId: ownerUserId,
        spawnedByTaskId: claim.taskId,
        parentWorkItemId: null,
      });
    },
  );

  concurrentTest(
    "an older item doesn't overwrite a newer one and counts as unchanged",
    async () => {
      const p = prefix();
      const claim = await startClaimedRun(importGrants(p));
      await unwrapAsync(
        upsert(claim, [
          item(`${p}1`, "2026-10-05T00:00:00.000Z", { title: "Newer" }),
        ]),
      );

      const response = await upsert(claim, [
        item(`${p}1`, "2026-10-01T00:00:00.000Z", { title: "Older" }),
      ]);

      expect(response.status).toBe(200);
      expect(response.data).toEqual({
        items: [],
        counts: { created: 0, updated: 0, unchanged: 1 },
      });
      expect((await load("custom", `${p}1`))?.title).toBe("Newer");
    },
  );

  concurrentTest(
    "a closed source item closes its item, and a reopened one reopens it",
    async () => {
      const p = prefix();
      const claim = await startClaimedRun(importGrants(p));
      await unwrapAsync(
        upsert(claim, [item(`${p}1`, "2026-10-01T00:00:00.000Z")]),
      );

      await unwrapAsync(
        upsert(claim, [
          item(`${p}1`, "2026-10-02T00:00:00.000Z", { state: "closed" }),
        ]),
      );
      expect(await load("custom", `${p}1`)).toMatchObject({
        state: "closed",
        closure: { reason: "completed" },
      });

      await unwrapAsync(
        upsert(claim, [
          item(`${p}1`, "2026-10-03T00:00:00.000Z", { state: "open" }),
        ]),
      );
      expect(await load("custom", `${p}1`)).toMatchObject({
        state: "open",
        closure: null,
      });
    },
  );

  concurrentTest("workItem.created fires once per key", async () => {
    const p = prefix();
    const claim = await startClaimedRun(importGrants(p));
    const first = await unwrapAsync(
      upsert(claim, [item(`${p}1`, "2026-10-01T00:00:00.000Z")]),
    );
    await unwrapAsync(
      upsert(claim, [item(`${p}1`, "2026-10-02T00:00:00.000Z")]),
    );
    await unwrapAsync(
      upsert(claim, [item(`${p}1`, "2026-10-02T00:00:00.000Z")]),
    );

    const id = first.items[0]?.workItemId ?? "";
    expect(
      requireSetup()
        .recorder.about([id])
        .filter((each) => each.event === "created"),
    ).toHaveLength(1);
  });

  concurrentTest("jira and github items keep their platform", async () => {
    const p = prefix();
    const claim = await startClaimedRun(importGrants(p));

    const response = await upsert(claim, [
      item(`${p}ACME-1`, "2026-10-01T00:00:00.000Z", { platform: "jira" }),
      item(`${p}acme/app#1`, "2026-10-01T00:00:00.000Z", {
        platform: "github",
      }),
    ]);

    expect(response.data?.items.map((each) => each.platform)).toEqual([
      "jira",
      "github",
    ]);
    expect((await load("jira", `${p}ACME-1`))?.platform).toBe("jira");
    expect((await load("github", `${p}acme/app#1`))?.platform).toBe("github");
  });

  describe("refusals write nothing", () => {
    concurrentTest(
      "a new key without create fails the whole call",
      async () => {
        const p = prefix();
        const owners = await startClaimedRun(importGrants(p));
        await unwrapAsync(
          upsert(owners, [item(`${p}1`, "2026-10-01T00:00:00.000Z")]),
        );
        const claim = await startClaimedRun([
          projectGrant("update", { keyPrefix: p }),
        ]);

        const response = await upsert(claim, [
          item(`${p}1`, "2026-10-02T00:00:00.000Z", { title: "Changed" }),
          item(`${p}2`, "2026-10-02T00:00:00.000Z"),
        ]);

        expectGrantMissing(response, "no create grant on project");
        expect((await load("custom", `${p}1`))?.title).toBe(`Ticket ${p}1`);
        expect(await load("custom", `${p}2`)).toBeNull();
      },
    );

    concurrentTest(
      "an existing key without update fails the whole call",
      async () => {
        const p = prefix();
        const owners = await startClaimedRun(importGrants(p));
        await unwrapAsync(
          upsert(owners, [item(`${p}1`, "2026-10-01T00:00:00.000Z")]),
        );
        const claim = await startClaimedRun([
          projectGrant("create", { labels: ["imported"], keyPrefix: p }),
        ]);

        const response = await upsert(claim, [
          item(`${p}2`, "2026-10-02T00:00:00.000Z"),
          item(`${p}1`, "2026-10-02T00:00:00.000Z", { title: "Changed" }),
        ]);

        expectGrantMissing(response, "no update grant on project");
        expect(await load("custom", `${p}2`)).toBeNull();
        expect((await load("custom", `${p}1`))?.title).toBe(`Ticket ${p}1`);
      },
    );

    concurrentTest("a key outside keyPrefix fails the whole call", async () => {
      const p = prefix();
      const claim = await startClaimedRun(importGrants(p));

      const response = await upsert(claim, [
        item(`${p}1`, "2026-10-01T00:00:00.000Z"),
        item(`other-${p}1`, "2026-10-01T00:00:00.000Z"),
      ]);

      expectGrantMissing(response, `other-${p}1`);
      expect(await load("custom", `${p}1`)).toBeNull();
    });

    concurrentTest(
      "a label outside the grant fails the whole call",
      async () => {
        const p = prefix();
        const claim = await startClaimedRun(importGrants(p));

        const response = await upsert(claim, [
          item(`${p}1`, "2026-10-01T00:00:00.000Z", { labels: ["bug"] }),
        ]);

        expectGrantMissing(response, "labels bug");
        expect(await load("custom", `${p}1`)).toBeNull();
      },
    );

    concurrentTest("an agent step's run may not upsert", async () => {
      const p = prefix();
      const claim = await startClaimedRun(importGrants(p), undefined, "agent");

      expectGrantMissing(
        await upsert(claim, [item(`${p}1`, "2026-10-01T00:00:00.000Z")]),
        "code step",
      );
      expect(await load("custom", `${p}1`)).toBeNull();
    });

    concurrentTest(
      "a claiming user with only read is denied, whatever the grants",
      async () => {
        const p = prefix();
        const claim = await startClaimedRun(
          importGrants(p),
          await readMember(),
        );

        const response = await upsert(claim, [
          item(`${p}1`, "2026-10-01T00:00:00.000Z"),
        ]);

        expect(response.error?.status).toBe(403);
        expect(response.error?.value).toMatchObject({
          code: "PROJECT_FORBIDDEN",
        });
        expect(await load("custom", `${p}1`)).toBeNull();
      },
    );

    concurrentTest(
      "more than 100 items or a repeated key is invalid",
      async () => {
        const p = prefix();
        const claim = await startClaimedRun(importGrants(p));

        const tooMany = await upsert(
          claim,
          Array.from({ length: 101 }, (_, index) =>
            item(`${p}${String(index)}`, "2026-10-01T00:00:00.000Z"),
          ),
        );
        const repeated = await upsert(claim, [
          item(`${p}1`, "2026-10-01T00:00:00.000Z"),
          item(`${p}1`, "2026-10-02T00:00:00.000Z"),
        ]);

        expect(tooMany.error?.status).toBe(422);
        expect(repeated.error?.status).toBe(422);
        expect(await load("custom", `${p}1`)).toBeNull();
      },
    );

    concurrentTest("a body over 5 MiB is refused with 413", async () => {
      const claim = await startClaimedRun(importGrants());
      const response = await createApp(appContext).handle(
        new Request(
          `http://localhost/api/task-runs/${claim.task.id}/work-item-upserts`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              claimToken: claim.claimToken,
              items: [
                item("big", "2026-10-01T00:00:00.000Z", {
                  description: "x".repeat(5 * 1024 * 1024),
                }),
              ],
            }),
          },
        ),
      );

      expect(response.status).toBe(413);
    });
  });
});
