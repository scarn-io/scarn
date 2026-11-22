import { describe, expect, beforeAll } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

/**
 * Integration coverage for `DrizzleWorkItemRepo.saveManyIfSourceNewer` — the
 * atomic idempotency guard the GitHub issue webhook path relies on (decisions
 * 6/12, docs/plans/github-integration-sync-scaling.md). Asserted directly
 * against the repo (no application-layer import, per the integration-test
 * boundary rule) rather than through `upsertWorkItemFromGitHubIssueWebhook`,
 * so the guard itself — the `ON CONFLICT ... DO UPDATE ... WHERE
 * excluded.source_updated_at > work_items.source_updated_at` SQL condition —
 * is what's under test, not any application-level branching.
 */
describe("DrizzleWorkItemRepo.saveManyIfSourceNewer", () => {
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-07-01T12:00:00.000Z")),
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);

  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-save-many-if-newer-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "saveManyIfSourceNewer Project",
          description: "Project for the guarded-upsert repo test",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  const buildGitHubIssue = (opts: {
    projectId: string;
    platformKey: string;
    title: string;
    sourceUpdatedAt: Date | null;
  }) =>
    WorkItemEntity.create({
      projectId: parseUuidV7(opts.projectId),
      platform: "github",
      platformId: `node-${opts.platformKey}`,
      platformKey: opts.platformKey,
      url: `https://github.com/acme/repo/issues/${opts.platformKey}`,
      title: opts.title,
      description: "Repro",
      sourceCreatedAt: opts.sourceUpdatedAt,
      sourceUpdatedAt: opts.sourceUpdatedAt,
      fields: { state: "open" },
    });

  concurrentTest(
    "a sync upsert keeps the assignee set through `save`",
    async () => {
      if (!project) throw new Error("Expected project setup to complete");
      const platformKey = `acme/repo#${uuidv7()}`;
      const assigneeUserId = parseUuidV7(uuidv7());
      const [created] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Original title",
          sourceUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ]);
      if (!created) throw new Error("Expected the item to be created");
      await appContext.workItemRepo.save(created.assign(assigneeUserId));

      const [synced] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Synced title",
          sourceUpdatedAt: new Date("2026-06-02T00:00:00.000Z"),
        }),
      ]);
      const [resynced] = await appContext.workItemRepo.saveMany([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Resynced title",
          sourceUpdatedAt: new Date("2026-06-03T00:00:00.000Z"),
        }),
      ]);

      expect(synced?.title).toBe("Synced title");
      expect(synced?.assigneeUserId).toBe(assigneeUserId);
      expect(resynced?.title).toBe("Resynced title");
      expect(resynced?.assigneeUserId).toBe(assigneeUserId);
    },
  );

  concurrentTest(
    "applies the update when the incoming sourceUpdatedAt is strictly newer",
    async () => {
      if (!project) throw new Error("Expected project setup to complete");
      const platformKey = `acme/repo#${uuidv7()}`;

      const [created] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Original title",
          sourceUpdatedAt: new Date("2026-06-01T00:00:00.000Z"),
        }),
      ]);
      expect(created?.title).toBe("Original title");

      const [updated] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Newer title",
          sourceUpdatedAt: new Date("2026-06-02T00:00:00.000Z"),
        }),
      ]);
      expect(updated?.id).toBe(created?.id);
      expect(updated?.title).toBe("Newer title");
      if (!created) throw new Error("Expected the first upsert to persist");

      const persisted = await appContext.workItemRepo.load(created.id);
      expect(persisted?.title).toBe("Newer title");
    },
  );

  concurrentTest(
    "is a no-op when the incoming sourceUpdatedAt is older than what's stored",
    async () => {
      if (!project) throw new Error("Expected project setup to complete");
      const platformKey = `acme/repo#${uuidv7()}`;

      const [created] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Current title",
          sourceUpdatedAt: new Date("2026-06-10T00:00:00.000Z"),
        }),
      ]);
      expect(created?.title).toBe("Current title");

      const staleResult = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Stale out-of-order title",
          sourceUpdatedAt: new Date("2026-06-09T00:00:00.000Z"),
        }),
      ]);

      // Postgres omits a conflicting row from RETURNING entirely when its
      // `DO UPDATE ... WHERE` guard evaluates false — the array is empty, not
      // an entity carrying the rejected values.
      expect(staleResult).toHaveLength(0);
      if (!created) throw new Error("Expected the first upsert to persist");

      const persisted = await appContext.workItemRepo.load(created.id);
      expect(persisted?.title).toBe("Current title");
    },
  );

  concurrentTest(
    "is a no-op when the incoming sourceUpdatedAt exactly equals what's stored (duplicate/redelivered webhook)",
    async () => {
      if (!project) throw new Error("Expected project setup to complete");
      const platformKey = `acme/repo#${uuidv7()}`;
      const sourceUpdatedAt = new Date("2026-06-15T00:00:00.000Z");

      const [created] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "First delivery",
          sourceUpdatedAt,
        }),
      ]);
      expect(created?.title).toBe("First delivery");

      const redelivered = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "Redelivered (should be ignored)",
          sourceUpdatedAt,
        }),
      ]);

      expect(redelivered).toHaveLength(0);
      if (!created) throw new Error("Expected the first upsert to persist");

      const persisted = await appContext.workItemRepo.load(created.id);
      expect(persisted?.title).toBe("First delivery");
    },
  );

  concurrentTest(
    "applies the update when the stored sourceUpdatedAt is null, regardless of the incoming value",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const platformKey = `manual-${uuidv7()}`;

      // Seed a row with a null sourceUpdatedAt the same way the generic PUT
      // endpoint allows (see work-item.put.test.ts) — an unset watermark
      // must never permanently block the guarded upsert.
      const seeded = await unwrapAsync(
        apiClient.api["work-items"].put(
          {
            projectId: project.id,
            platform: "github",
            platformId: `node-${platformKey}`,
            platformKey,
            url: "https://github.com/acme/repo/issues/1",
            title: "Seeded with null watermark",
            description: "Repro",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: { state: "open" },
          },
          { headers: { ...authHeaders } },
        ),
      );

      const [updated] = await appContext.workItemRepo.saveManyIfSourceNewer([
        buildGitHubIssue({
          projectId: project.id,
          platformKey,
          title: "First real watermark",
          sourceUpdatedAt: new Date("2026-06-20T00:00:00.000Z"),
        }),
      ]);

      expect(updated?.id.toString()).toBe(seeded.id);
      expect(updated?.title).toBe("First real watermark");
    },
  );
});
