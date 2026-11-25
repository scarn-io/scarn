import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { concurrentTest } from "tests/utils";
import { expectPgError } from "tests/lib/db/orchestration-schema-test-support";
import { getDb } from "@/lib/db";
import { projectIntegrations, projects } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  GitHubAppProjectIntegration,
  GitHubTokenProjectIntegration,
  JiraProjectIntegration,
  type ProjectIntegrationStatus,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { DrizzleProjectIntegrationRepo } from "@/integrations/project-integration/infra/drizzle-project-integration-repo";

const seedProject = async (label: string): Promise<UuidV7> => {
  const db = getDb();
  const projectId = createUuidV7();
  await db.insert(projects).values({
    id: projectId,
    name: `project-integration repo test ${label}`,
    slug: `project-integration-repo-${label}-${crypto.randomUUID()}`,
    gitUrl: "https://github.com/example/test-project.git",
    createdByUserId: createUuidV7(),
    orgId: createUuidV7(),
  });
  return projectId;
};

/**
 * `listActive()` has no project scope by design (it backs the global
 * scheduled reconcile sweep in `reconcile-active-integrations.ts`), and the
 * test DB is a single shared instance that persists for the whole `bun test`
 * run rather than being reset per file. Deleting the seed project — which
 * cascades to its `project_integrations` rows — keeps this test's
 * active/error integrations from leaking into any other file's
 * `listActive()`/reconcile-endpoint assertions.
 */
const deleteProject = (projectId: UuidV7): Promise<unknown> =>
  getDb().delete(projects).where(eq(projects.id, projectId));

/**
 * Integration coverage for `DrizzleProjectIntegrationRepo`, focused on the
 * `listActive()` keyset-pagination behavior added to fix the unbounded
 * `select` that `reconcileActiveIntegrations` used to sweep against (see
 * `reconcile-active-integrations.ts`).
 */
describe("DrizzleProjectIntegrationRepo", () => {
  const repo = new DrizzleProjectIntegrationRepo();

  concurrentTest(
    "listActive() pages through multiple pages internally and returns the full active/error set, excluding paused",
    async () => {
      const projectId = await seedProject("list-active-pagination");
      try {
        const makeIntegration = (
          index: number,
          status: ProjectIntegrationStatus,
        ) =>
          GitHubAppProjectIntegration.rehydrate({
            id: createUuidV7(),
            projectId,
            installationId: `list-active-install-${String(index)}`,
            scope: {
              repos: [{ id: index, fullName: `acme/repo-${String(index)}` }],
            },
            status,
            lastSyncedAt: null,
            lastError: null,
            firstSyncHorizonDays: null,
          });

        // 5 active/error rows against a pageSize of 2 forces `listActive()`
        // to traverse 3 internal pages to return the full set.
        const activeOrErrorIntegrations = Array.from({ length: 5 }, (_, i) =>
          makeIntegration(i, i % 2 === 0 ? "active" : "error"),
        );
        const pausedIntegration = makeIntegration(99, "paused");

        for (const integration of [
          ...activeOrErrorIntegrations,
          pausedIntegration,
        ]) {
          await repo.create(integration);
        }

        const results = await repo.listActive(undefined, { pageSize: 2 });
        const resultIds = results
          .filter((r) => r.projectId === projectId)
          .map((r) => r.id)
          .sort();

        expect(resultIds).toEqual(
          activeOrErrorIntegrations.map((r) => r.id).sort(),
        );
        expect(results.some((r) => r.id === pausedIntegration.id)).toBe(false);
      } finally {
        await deleteProject(projectId);
      }
    },
  );

  concurrentTest(
    "listActive() with the default page size still returns every matching row in one call",
    async () => {
      const projectId = await seedProject("list-active-default-page-size");
      try {
        const integration = GitHubAppProjectIntegration.rehydrate({
          id: createUuidV7(),
          projectId,
          installationId: "default-page-size-install",
          scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
          status: "active",
          lastSyncedAt: null,
          lastError: null,
          firstSyncHorizonDays: null,
        });
        await repo.create(integration);

        const results = await repo.listActive();
        expect(results.some((r) => r.id === integration.id)).toBe(true);
      } finally {
        await deleteProject(projectId);
      }
    },
  );

  concurrentTest("each kind loads back as the same variant class", async () => {
    const projectId = await seedProject("kind-roundtrip");
    const installationId = `roundtrip-install-${crypto.randomUUID()}`;
    try {
      const github = await repo.create(
        GitHubAppProjectIntegration.create({
          projectId,
          installationId,
          scope: { repos: [{ id: 7, fullName: "acme/roundtrip" }] },
        }),
      );
      const jira = await repo.create(
        JiraProjectIntegration.create({
          projectId,
          scope: {
            baseUrl: "https://acme.atlassian.net",
            projectKeys: ["ACME", "OPS"],
          },
        }),
      );

      const loadedGitHub = await repo.findById(github.id);
      const loadedJira = await repo.findById(jira.id);

      expect(loadedGitHub).toBeInstanceOf(GitHubAppProjectIntegration);
      expect(loadedGitHub?.toJSON()).toMatchObject({
        kind: "github_app",
        installationId,
        externalScopeJson: { repos: [{ id: 7, fullName: "acme/roundtrip" }] },
      });
      expect(loadedJira).toBeInstanceOf(JiraProjectIntegration);
      expect(loadedJira?.toJSON()).toMatchObject({
        kind: "jira",
        installationId: null,
        externalScopeJson: {
          baseUrl: "https://acme.atlassian.net",
          projectKeys: ["ACME", "OPS"],
        },
      });
      expect(
        (await repo.findByInstallationId(installationId)).map(
          (entry) => entry.id,
        ),
      ).toEqual([github.id]);
    } finally {
      await deleteProject(projectId);
    }
  });

  concurrentTest(
    "a row whose scope does not fit its kind fails to load with PROJECT_INTEGRATION_ROW_UNREADABLE",
    async () => {
      const projectId = await seedProject("row-invalid");
      try {
        const id = createUuidV7();
        await getDb()
          .insert(projectIntegrations)
          .values({
            id,
            projectId,
            kind: "jira",
            installationId: null,
            externalScopeJson: { repos: [{ id: 1, fullName: "acme/repo" }] },
            schemaVersion: 1,
            status: "paused",
          });

        let caught: unknown;
        try {
          await repo.findById(id);
        } catch (error: unknown) {
          caught = error;
        }

        expect(caught).toMatchObject({
          code: "PROJECT_INTEGRATION_ROW_UNREADABLE",
        });
      } finally {
        await deleteProject(projectId);
      }
    },
  );

  concurrentTest(
    "round-trips a GitHub token integration with no installation id",
    async () => {
      const projectId = await seedProject("github-token-round-trip");
      try {
        const created = await repo.create(
          GitHubTokenProjectIntegration.create({
            projectId,
            scope: { repos: [{ id: 42, fullName: "acme/token-repo" }] },
          }),
        );

        const loaded = await repo.findById(created.id);

        expect(loaded).toBeInstanceOf(GitHubTokenProjectIntegration);
        expect(loaded?.toJSON()).toEqual(created.toJSON());
        expect(loaded?.toJSON().installationId).toBeNull();
      } finally {
        await deleteProject(projectId);
      }
    },
  );

  concurrentTest(
    "the database rejects a Jira row with an installation id",
    async () => {
      const projectId = await seedProject("jira-installation-check");
      try {
        await expectPgError(
          () =>
            getDb()
              .insert(projectIntegrations)
              .values({
                id: createUuidV7(),
                projectId,
                kind: "jira",
                installationId: "https://acme.atlassian.net",
                externalScopeJson: {
                  baseUrl: "https://acme.atlassian.net",
                  projectKeys: ["ACME"],
                },
                schemaVersion: 1,
                status: "active",
              }),
          {
            code: "23514",
            constraint: "project_integrations_kind_installation_check",
          },
        );
      } finally {
        await deleteProject(projectId);
      }
    },
  );
});
