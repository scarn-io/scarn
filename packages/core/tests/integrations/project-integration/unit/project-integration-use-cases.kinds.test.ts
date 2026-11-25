import { describe, expect, test } from "bun:test";
import { createProjectIntegration } from "@/integrations/project-integration/application/create-project-integration";
import { updateProjectIntegrationScope } from "@/integrations/project-integration/application/update-project-integration-scope";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import type { ProjectIntegrationEntity } from "@/integrations/project-integration/domain/project-integration-entity";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const JIRA_SCOPE = {
  baseUrl: "https://acme.atlassian.net",
  projectKeys: ["ACME"],
};

const unsupported = (): never => {
  throw new Error("not used by these tests");
};

const makeRepo = (): ProjectIntegrationRepo => {
  const stored = new Map<string, ProjectIntegrationEntity>();
  return {
    create(integration) {
      stored.set(integration.id, integration);
      return Promise.resolve(integration);
    },
    save(integration) {
      stored.set(integration.id, integration);
      return Promise.resolve(integration);
    },
    findById(id) {
      return Promise.resolve(stored.get(id) ?? null);
    },
    listByProjectId(target) {
      return Promise.resolve(
        [...stored.values()].filter((entry) => entry.projectId === target),
      );
    },
    findByInstallationId: unsupported,
    listActive: unsupported,
    delete: unsupported,
    deleteByInstallationId: unsupported,
  };
};

const errorCode = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (caught: unknown) {
    if (caught instanceof CoreValidationError) return caught.code;
    throw caught;
  }
  return null;
};

describe("createProjectIntegration duplicate rule", () => {
  test("rejects a second GitHub App integration that shares a repo", async () => {
    const repo = makeRepo();
    await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "1",
        externalScope: { repos: [{ id: 1, fullName: "acme/a" }] },
      },
      repo,
    );

    const code = await errorCode(() =>
      createProjectIntegration(
        {
          projectId,
          kind: "github_app",
          installationId: "2",
          externalScope: { repos: [{ id: 1, fullName: "Acme/A" }] },
        },
        repo,
      ),
    );

    expect(code).toBe("PROJECT_INTEGRATION_DUPLICATE");
  });

  test("allows GitHub App integrations on different installations and repos", async () => {
    const repo = makeRepo();
    await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "1",
        externalScope: { repos: [{ id: 1, fullName: "acme/a" }] },
      },
      repo,
    );

    const second = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "2",
        externalScope: { repos: [{ id: 2, fullName: "acme/b" }] },
      },
      repo,
    );

    expect(second.kind).toBe("github_app");
  });

  test("rejects a second Jira integration for the same site", async () => {
    const repo = makeRepo();
    await createProjectIntegration(
      { projectId, kind: "jira", externalScope: JIRA_SCOPE },
      repo,
    );

    const code = await errorCode(() =>
      createProjectIntegration(
        {
          projectId,
          kind: "jira",
          externalScope: { ...JIRA_SCOPE, projectKeys: ["OPS"] },
        },
        repo,
      ),
    );

    expect(code).toBe("PROJECT_INTEGRATION_DUPLICATE");
  });

  test("a Jira integration and a GitHub App integration never collide", async () => {
    const repo = makeRepo();
    await createProjectIntegration(
      { projectId, kind: "jira", externalScope: JIRA_SCOPE },
      repo,
    );

    const github = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "1",
        externalScope: { repos: [{ id: 1, fullName: "acme/a" }] },
      },
      repo,
    );

    expect(github.kind).toBe("github_app");
  });
});

describe("updateProjectIntegrationScope", () => {
  test("replaces a Jira integration's scope", async () => {
    const repo = makeRepo();
    const created = await createProjectIntegration(
      { projectId, kind: "jira", externalScope: JIRA_SCOPE },
      repo,
    );

    const updated = await updateProjectIntegrationScope(
      {
        id: created.id,
        projectId,
        kind: "jira",
        externalScope: { ...JIRA_SCOPE, projectKeys: ["ACME", "OPS"] },
      },
      repo,
    );

    if (updated.kind !== "jira") throw new Error("expected jira");
    expect(updated.scope.projectKeys).toEqual(["ACME", "OPS"]);
  });

  test("rejects a scope for a different kind", async () => {
    const repo = makeRepo();
    const created = await createProjectIntegration(
      { projectId, kind: "jira", externalScope: JIRA_SCOPE },
      repo,
    );

    const code = await errorCode(() =>
      updateProjectIntegrationScope(
        {
          id: created.id,
          projectId,
          kind: "github_app",
          externalScope: { repos: [{ id: 1, fullName: "acme/a" }] },
        },
        repo,
      ),
    );

    expect(code).toBe("PROJECT_INTEGRATION_KIND_MISMATCH");
  });
});
