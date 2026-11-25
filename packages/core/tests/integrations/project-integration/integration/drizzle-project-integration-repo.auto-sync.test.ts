import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { concurrentTest } from "tests/utils";
import { getDb } from "@/lib/db";
import { projectIntegrations, projects, secrets } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  JiraProjectIntegration,
  type ProjectIntegrationStatus,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { DrizzleProjectIntegrationRepo } from "@/integrations/project-integration/infra/drizzle-project-integration-repo";

const seedProject = async (label: string): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: `project-integration auto-sync repo test ${label}`,
      slug: `project-integration-auto-sync-${label}-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

/** Cascades to the project's integrations so none leak into global sweeps. */
const deleteProject = (projectId: UuidV7): Promise<unknown> =>
  getDb().delete(projects).where(eq(projects.id, projectId));

const seedSecret = async (
  kind: "jira_api_key" | "github_token",
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(secrets)
    .values({
      id,
      ownerUserId: createUuidV7(),
      kind,
      name: `auto-sync repo test ${id}`,
      metadataJson: {},
      schemaVersion: 1,
      ciphertext: Buffer.from("ciphertext"),
      iv: Buffer.from("iv"),
      authTag: Buffer.from("tag"),
      keyVersion: 1,
      lastFour: "abcd",
    });
  return id;
};

const deleteSecret = (secretId: UuidV7): Promise<unknown> =>
  getDb().delete(secrets).where(eq(secrets.id, secretId));

/** Auto-sync queries and the sync claim lock on `DrizzleProjectIntegrationRepo`. */
describe("DrizzleProjectIntegrationRepo auto-sync", () => {
  const repo = new DrizzleProjectIntegrationRepo();

  concurrentTest(
    "listDueForAutoSync() returns only lent-key rows in active or error status",
    async () => {
      const projectId = await seedProject("list-due-for-auto-sync");
      const secretId = await seedSecret("jira_api_key");
      try {
        const jira = (
          status: ProjectIntegrationStatus,
          syncSecretId: UuidV7 | null,
        ) =>
          JiraProjectIntegration.rehydrate({
            id: createUuidV7(),
            projectId,
            scope: {
              baseUrl: "https://acme.atlassian.net",
              projectKeys: ["ACME"],
            },
            status,
            lastSyncedAt: null,
            lastError: null,
            firstSyncHorizonDays: null,
            syncSecretId,
            autoSyncPausedReason: null,
            autoSyncPausedAt: null,
            autoSyncPausedDetail: null,
          });

        const dueActive = await repo.create(jira("active", secretId));
        const dueError = await repo.create(jira("error", secretId));
        const lentButPaused = await repo.create(jira("paused", secretId));
        const noKey = await repo.create(jira("active", null));
        const autoSyncPaused = await repo.create(
          jira("active", null).withAutoSyncPaused("key_rejected", new Date()),
        );

        const results = await repo.listDueForAutoSync(undefined, {
          pageSize: 1,
        });
        const ids = new Set(results.map((r) => r.id));

        expect(ids.has(dueActive.id)).toBe(true);
        expect(ids.has(dueError.id)).toBe(true);
        expect(ids.has(lentButPaused.id)).toBe(false);
        expect(ids.has(noKey.id)).toBe(false);
        expect(ids.has(autoSyncPaused.id)).toBe(false);

        const bySecret = await repo.listBySyncSecretId(secretId);
        expect(bySecret.map((r) => r.id).sort()).toEqual(
          [dueActive.id, dueError.id, lentButPaused.id].sort(),
        );
      } finally {
        await deleteProject(projectId);
        await deleteSecret(secretId);
      }
    },
  );

  concurrentTest(
    "claimForSync() holds an exclusive lock until it expires or is released",
    async () => {
      const projectId = await seedProject("claim-for-sync");
      try {
        const integration = await repo.create(
          JiraProjectIntegration.create({
            projectId,
            scope: {
              baseUrl: "https://acme.atlassian.net",
              projectKeys: ["ACME"],
            },
          }),
        );
        const lockedUntil = async () =>
          (
            await getDb()
              .select({ until: projectIntegrations.syncLockedUntil })
              .from(projectIntegrations)
              .where(eq(projectIntegrations.id, integration.id))
          )[0]?.until ?? null;
        const inFourMinutes = () => new Date(Date.now() + 4 * 60_000);

        expect(await repo.claimForSync(integration.id, inFourMinutes())).toBe(
          true,
        );
        expect(await repo.claimForSync(integration.id, inFourMinutes())).toBe(
          false,
        );

        await repo.releaseSyncClaim(integration.id);
        expect(await lockedUntil()).toBeNull();

        const alreadyExpired = new Date(Date.now() - 60_000);
        expect(await repo.claimForSync(integration.id, alreadyExpired)).toBe(
          true,
        );
        expect(await repo.claimForSync(integration.id, inFourMinutes())).toBe(
          true,
        );
        expect(await repo.claimForSync(createUuidV7(), inFourMinutes())).toBe(
          false,
        );
      } finally {
        await deleteProject(projectId);
      }
    },
  );
});
