import { describe, expect, test } from "bun:test";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  createRelationshipsTestHarness,
  makeRelationshipsFetchImpl,
  useGithubRelationshipsTestEnv,
} from "./run-project-integration-sync-relationships-test-support";

/**
 * GitHub sync maps `issue.state` onto `work_items.state` (A-11), on both
 * create and update. Reassigns `globalThis.fetch`, so tests run serially.
 */
describe("GitHub sync work item state", () => {
  useGithubRelationshipsTestEnv();
  const { createProjectWithGitHubIntegration, runSync, loadSyncedWorkItem } =
    createRelationshipsTestHarness();

  test.serial(
    "stores closed for a closed issue and open for an open one",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-state-create-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/state-create";
      const { project, integrationId } =
        await createProjectWithGitHubIntegration(
          owner,
          "GitHub State Create",
          repoFullName,
        );

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1, state: "closed" }, { number: 2 }],
      });

      await runSync(project.id, integrationId, owner.authHeaders);

      const closed = await loadSyncedWorkItem(project.id, repoFullName, 1);
      const open = await loadSyncedWorkItem(project.id, repoFullName, 2);
      expect(closed.state).toBe("closed");
      expect(closed.closure).toMatchObject({
        reason: "completed",
        resolution: null,
        closedByUserId: null,
        closedByTaskId: null,
      });
      expect(closed.spawnedByTaskId).toBeNull();
      expect(open.state).toBe("open");
      expect(open.closure).toBeNull();
    },
  );

  test.serial(
    "updates state when a synced issue closes and reopens",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-state-update-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/state-update";
      const { project, integrationId } =
        await createProjectWithGitHubIntegration(
          owner,
          "GitHub State Update",
          repoFullName,
        );

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1 }],
      });
      await runSync(project.id, integrationId, owner.authHeaders);
      expect(
        (await loadSyncedWorkItem(project.id, repoFullName, 1)).state,
      ).toBe("open");

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1, state: "closed" }],
      });
      await runSync(project.id, integrationId, owner.authHeaders);
      const closed = await loadSyncedWorkItem(project.id, repoFullName, 1);
      expect(closed.state).toBe("closed");
      expect(closed.closure).toMatchObject({
        reason: "completed",
        resolution: null,
        closedByUserId: null,
      });

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1 }],
      });
      await runSync(project.id, integrationId, owner.authHeaders);
      const reopened = await loadSyncedWorkItem(project.id, repoFullName, 1);
      expect(reopened.state).toBe("open");
      expect(reopened.closure).toBeNull();
    },
  );
});
