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

describe("step definition repo post endpoint", () => {
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

  concurrentTest(
    "creates a step definition with a readWrite repo and keeps message and onPushFailure",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            environment: { kind: "inline", runtime: { kind: "devcontainer" } },
            repo: {
              mode: "readWrite" as const,
              message: "fix: {{result.summary}} for {{input.title}}",
              onPushFailure: "warn" as const,
            },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.repo).toEqual({
        mode: "readWrite",
        message: "fix: {{result.summary}} for {{input.title}}",
        onPushFailure: "warn",
        gitCredentials: "auto",
        baseBranch: null,
        workBranch: { kind: "create" },
      });
    },
  );

  concurrentTest(
    "creates a step definition with a readOnly repo on a workspace step",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            environment: { kind: "inline", runtime: { kind: "devcontainer" } },
            repo: { mode: "readOnly" as const },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.repo).toEqual({
        mode: "readOnly",
        gitCredentials: "auto",
        baseBranch: null,
      });
    },
  );

  concurrentTest(
    "creates a host step with non-committing repo access and no credentials",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            environment: { kind: "inline", runtime: { kind: "host" } },
            repo: {
              mode: "readOnly" as const,
              gitCredentials: "none" as const,
            },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.repo).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
    },
  );

  concurrentTest(
    "an omitted repo resolves to readWrite with a null message and fail for a workspace step",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const explicit = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            environment: { kind: "inline", runtime: { kind: "devcontainer" } },
          },
          { headers: { ...authHeaders } },
        ),
      );
      const implicit = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          buildPayload(parseUuidV7(project.id)),
          { headers: { ...authHeaders } },
        ),
      );

      expect(explicit.repo).toEqual(DEFAULT_WRITE);
      expect(implicit.repo).toEqual(DEFAULT_WRITE);
    },
  );

  concurrentTest(
    "an omitted repo resolves to readWrite for a host step",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            environment: { kind: "inline", runtime: { kind: "host" } },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.repo).toEqual(DEFAULT_WRITE);
    },
  );

  concurrentTest(
    "a readWrite repo with only a mode resolves its message to null and onPushFailure to fail",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            repo: { mode: "readWrite" as const },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.repo).toEqual({
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        baseBranch: null,
        workBranch: { kind: "create" },
      });
    },
  );

  concurrentTest("accepts the resolved repo it returned as input", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildPayload(parseUuidV7(project.id)),
        { headers: { ...authHeaders } },
      ),
    );
    const echoed = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          ...buildPayload(parseUuidV7(project.id)),
          repo: created.repo,
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(echoed.repo).toEqual(created.repo);
  });

  const invalidRepoCases: {
    name: string;
    runtimeKind?: "devcontainer" | "host";
    repo: unknown;
  }[] = [
    { name: "an unknown mode", repo: { mode: "readwrite" } },
    { name: "a missing mode", repo: {} },
    { name: "an unknown key", repo: { mode: "readWrite", branch: "x" } },
    {
      name: "an invalid onPushFailure",
      repo: { mode: "readWrite", onPushFailure: "ignore" },
    },
    {
      name: "a multi-line message",
      repo: { mode: "readWrite", message: "one\ntwo" },
    },
    {
      name: "a message with an env token",
      repo: { mode: "readWrite", message: "{{env.TOKEN}}" },
    },
    {
      name: "a message over 500 characters",
      repo: { mode: "readWrite", message: "x".repeat(501) },
    },
    {
      name: "none with host",
      runtimeKind: "host",
      repo: { mode: "none" },
    },
    {
      name: "none with devcontainer",
      runtimeKind: "devcontainer",
      repo: { mode: "none" },
    },
    {
      name: "none with the repository runtime",
      repo: { mode: "none" },
    },
    {
      name: "a message with readOnly",
      runtimeKind: "devcontainer",
      repo: { mode: "readOnly", message: "fix" },
    },
    {
      name: "onPushFailure with readOnly",
      runtimeKind: "devcontainer",
      repo: { mode: "readOnly", onPushFailure: "fail" },
    },
    {
      name: "a message with none",
      runtimeKind: "host",
      repo: { mode: "none", message: "fix" },
    },
  ];

  for (const { name, runtimeKind, repo } of invalidRepoCases) {
    concurrentTest(`returns 422 for ${name}`, async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].post(
        {
          ...buildPayload(parseUuidV7(project.id)),
          ...(runtimeKind
            ? {
                environment: { kind: "inline", runtime: { kind: runtimeKind } },
              }
            : {}),
          repo,
        } as never,
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        status: 422,
        code: "VALIDATION",
        title: "Unprocessable Content",
      });
    });
  }
});
