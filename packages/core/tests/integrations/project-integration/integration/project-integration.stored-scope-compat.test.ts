/**
 * Stored `project_integrations` rows stay readable as the scope contracts
 * evolve. Rows are written directly, bypassing the entity, to stand in for
 * integrations created by older code. See `docs/persistence/json-columns.md`.
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { Logger } from "@scarn/observability/logging";
import { getDb } from "@/lib/db";
import { projectIntegrations, projects, secrets } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleProjectIntegrationRepo } from "@/integrations/project-integration/infra/drizzle-project-integration-repo";
import { concurrentTest } from "tests/utils";
import v1GitHubFixture from "../fixtures/v1-github.json";
import v1BitbucketFixture from "../fixtures/v1-bitbucket.json";
import v1JiraFixture from "../fixtures/v1-jira.json";

type StoredRow = {
  schemaVersion: number;
  kind: "github_app" | "github_token" | "bitbucket" | "jira";
  installationId: string | null;
  externalScopeJson: unknown;
};

const recordingLogger = () => {
  const errors: unknown[][] = [];
  const logger = {
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, errors };
};

const seedProject = async (): Promise<UuidV7> => {
  const projectId = createUuidV7();
  await getDb()
    .insert(projects)
    .values({
      id: projectId,
      name: "project-integration stored scope compat",
      slug: `project-integration-stored-scope-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  return projectId;
};

const seedSecret = async (): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(secrets)
    .values({
      id,
      ownerUserId: createUuidV7(),
      kind: "jira_api_key",
      name: `stored scope compat ${id}`,
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

const insertRow = async (
  projectId: UuidV7,
  row: StoredRow,
  syncSecretId: UuidV7 | null = null,
): Promise<UuidV7> => {
  const id = createUuidV7();
  await getDb()
    .insert(projectIntegrations)
    .values({
      id,
      projectId,
      kind: row.kind,
      installationId:
        row.kind === "github_app"
          ? `${row.installationId ?? "install"}-${crypto.randomUUID()}`
          : row.installationId,
      externalScopeJson: row.externalScopeJson,
      schemaVersion: row.schemaVersion,
      status: "active",
      syncSecretId,
    });
  return id;
};

const rejectionOf = async <T>(promise: Promise<T>) => {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
};

describe("project integration stored scope compatibility", () => {
  for (const [name, fixture] of [
    ["github", v1GitHubFixture],
    ["bitbucket", v1BitbucketFixture],
    ["jira", v1JiraFixture],
  ] as const) {
    concurrentTest(
      `reads the v1 ${name} fixture through the repo`,
      async () => {
        const projectId = await seedProject();
        try {
          const id = await insertRow(projectId, fixture as StoredRow);
          const integration =
            await new DrizzleProjectIntegrationRepo().findById(id);
          expect<string | undefined>(integration?.kind).toBe(fixture.kind);
          expect(integration?.toJSON().externalScopeJson).toEqual(
            fixture.externalScopeJson,
          );
        } finally {
          await getDb().delete(projects).where(eq(projects.id, projectId));
        }
      },
    );
  }

  concurrentTest(
    "an unreadable integration is logged with its id and skipped by list reads, and throws on single reads",
    async () => {
      const projectId = await seedProject();
      const secretId = await seedSecret();
      const { logger, errors } = recordingLogger();
      const repo = new DrizzleProjectIntegrationRepo(logger);
      try {
        const readableId = await insertRow(
          projectId,
          v1JiraFixture as StoredRow,
          secretId,
        );
        const unreadableId = await insertRow(
          projectId,
          {
            schemaVersion: 1,
            kind: "jira",
            installationId: null,
            externalScopeJson: v1GitHubFixture.externalScopeJson,
          },
          secretId,
        );

        const byProject = await repo.listByProjectId(projectId);
        expect(byProject.map((integration) => integration.id)).toEqual([
          readableId,
        ]);

        const bySecret = await repo.listBySyncSecretIds([secretId]);
        expect(bySecret.map((integration) => integration.id)).toEqual([
          readableId,
        ]);

        for (const listed of [
          await repo.listDueForAutoSync(),
          await repo.listActive(),
        ]) {
          const ids = listed.map((integration) => integration.id);
          expect(ids).toContain(readableId);
          expect(ids).not.toContain(unreadableId);
        }

        expect(
          errors.some(
            ([fields]) =>
              (fields as { projectIntegrationId?: string })
                .projectIntegrationId === unreadableId,
          ),
        ).toBe(true);

        expect(await rejectionOf(repo.findById(unreadableId))).toMatchObject({
          code: "PROJECT_INTEGRATION_ROW_UNREADABLE",
        });
      } finally {
        await getDb().delete(projects).where(eq(projects.id, projectId));
        await getDb().delete(secrets).where(eq(secrets.id, secretId));
      }
    },
  );
});
