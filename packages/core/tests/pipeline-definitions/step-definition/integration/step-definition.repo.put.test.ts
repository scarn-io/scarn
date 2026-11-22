import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const buildPayload = (projectId: UuidV7) => ({
  projectId,
  key: `repo_config_${crypto.randomUUID()}`,
  name: "Repo config",
  description: null,
  prompt: "Run the build and return a typed result.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "draft" as const,
});

const DEFAULT_WRITE = {
  mode: "readWrite",
  message: null,
  onPushFailure: "fail",
  gitCredentials: "auto",
  baseBranch: null,
  workBranch: { kind: "create" },
} as const;

describe("step definition repo put endpoint", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-repo-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Repo Project",
          description: "Project for repo tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest("upsert sets and changes repo", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const payload = {
      ...buildPayload(parseUuidV7(project.id)),
      environment: {
        kind: "inline" as const,
        runtime: { kind: "devcontainer" as const },
      },
    };
    const put = (
      repo?: Parameters<
        (typeof apiClient.api)["step-definitions"]["put"]
      >[0]["repo"],
    ) =>
      unwrapAsync(
        apiClient.api["step-definitions"].put(
          { ...payload, repo },
          { headers: { ...authHeaders } },
        ),
      );

    const created = await put();
    expect(created.repo).toEqual(DEFAULT_WRITE);

    const withMessage = await put({
      mode: "readWrite",
      message: "fix: {{result.summary}}",
      onPushFailure: "warn",
    });
    expect(withMessage.id).toBe(created.id);
    expect(withMessage.repo).toEqual({
      mode: "readWrite",
      message: "fix: {{result.summary}}",
      onPushFailure: "warn",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    });

    const readOnly = await put({ mode: "readOnly" });
    expect(readOnly.repo).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      baseBranch: null,
    });

    const withCredentials = await put({
      mode: "readOnly",
      gitCredentials: "none",
    });
    expect(withCredentials.repo).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
      baseBranch: null,
    });

    const reloaded = await unwrapAsync(
      apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get({
        headers: { ...authHeaders },
      }),
    );
    expect(reloaded.repo).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
      baseBranch: null,
    });

    const backToWrite = await put({ mode: "readWrite", message: null });
    expect(backToWrite.repo).toEqual(DEFAULT_WRITE);
  });

  concurrentTest(
    "create and upsert persist maxTurns, null by default",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = buildPayload(parseUuidV7(project.id));
      const created = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          { ...payload, maxTurns: 3 },
          { headers: { ...authHeaders } },
        ),
      );
      expect(created.maxTurns).toBe(3);

      const upserted = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          { ...payload, maxTurns: 5 },
          { headers: { ...authHeaders } },
        ),
      );
      expect(upserted.id).toBe(created.id);

      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get(
          { headers: { ...authHeaders } },
        ),
      );
      expect(reloaded.maxTurns).toBe(5);

      const cleared = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, {
          headers: { ...authHeaders },
        }),
      );
      expect(cleared.maxTurns).toBeNull();
    },
  );

  concurrentTest(
    "upsert resets an omitted repo to readWrite independently of runtime switches",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = buildPayload(parseUuidV7(project.id));
      const customRepo = {
        mode: "readWrite" as const,
        message: "fix: {{result.summary}}",
        onPushFailure: "warn" as const,
        gitCredentials: "auto" as const,
        baseBranch: null,
        workBranch: { kind: "create" as const },
      };
      const put = (body: object) =>
        unwrapAsync(
          apiClient.api["step-definitions"].put(
            { ...payload, ...body },
            { headers: { ...authHeaders } },
          ),
        );

      const custom = await put({
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
        repo: customRepo,
      });
      expect(custom.repo).toEqual(customRepo);

      const toHost = await put({
        environment: { kind: "inline", runtime: { kind: "host" } },
      });
      expect(toHost.repo).toEqual(DEFAULT_WRITE);
      expect(toHost.environment).toEqual({
        kind: "inline",
        runtime: { kind: "host" },
      });

      const toDevcontainer = await put({
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      });
      expect(toDevcontainer.repo).toEqual(DEFAULT_WRITE);
      expect(toDevcontainer.environment).toEqual({
        kind: "inline",
        runtime: { kind: "devcontainer" },
      });

      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: custom.id }).get({
          headers: { ...authHeaders },
        }),
      );
      expect(reloaded.repo).toEqual(DEFAULT_WRITE);
    },
  );

  concurrentTest(
    "upsert without repo resets a custom repo to the default, like envJson",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = {
        ...buildPayload(parseUuidV7(project.id)),
        environment: {
          kind: "inline" as const,
          runtime: { kind: "devcontainer" as const },
        },
      };
      await unwrapAsync(
        apiClient.api["step-definitions"].put(
          { ...payload, repo: { mode: "readOnly" as const } },
          { headers: { ...authHeaders } },
        ),
      );

      const reset = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, {
          headers: { ...authHeaders },
        }),
      );
      expect(reset.repo).toEqual(DEFAULT_WRITE);
    },
  );

  concurrentTest(
    "upsert accepts a runtime change that keeps a readWrite repo",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = buildPayload(parseUuidV7(project.id));
      await unwrapAsync(
        apiClient.api["step-definitions"].put(
          {
            ...payload,
            environment: { kind: "inline", runtime: { kind: "devcontainer" } },
          },
          { headers: { ...authHeaders } },
        ),
      );

      const { data, error } = await apiClient.api["step-definitions"].put(
        {
          ...payload,
          environment: { kind: "inline", runtime: { kind: "host" } },
          repo: { mode: "readWrite" as const },
        },
        { headers: { ...authHeaders } },
      );

      expect(error).toBeNull();
      expect(data?.environment).toEqual({
        kind: "inline",
        runtime: { kind: "host" },
      });
      expect(data?.repo).toEqual(DEFAULT_WRITE);
    },
  );
});
