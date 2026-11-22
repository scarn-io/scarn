import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const buildCodePayload = (projectId: UuidV7) => ({
  projectId,
  key: `managed_runtime_${crypto.randomUUID()}`,
  name: "Managed runtime",
  description: null,
  version: 1,
  kind: "code" as const,
  entrypointJson: {
    sourceFile: ".scarn/pipeline-builder/lookup.ts",
  },
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "draft" as const,
});

const buildAgentPayload = (projectId: UuidV7) => ({
  projectId,
  key: `managed_runtime_agent_${crypto.randomUUID()}`,
  name: "Managed runtime agent",
  description: null,
  prompt: "Run the build and return a typed result.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "draft" as const,
});

const expectValidationError = (
  error: { status: number; value: unknown } | null,
) => {
  expect(error?.status).toBe(422);
  expect(error?.value).toMatchObject({
    status: 422,
    code: "VALIDATION",
    title: "Unprocessable Content",
  });
};

describe("step definition managedRuntime", () => {
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
      email: `step-definition-managed-runtime-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Managed Runtime Project",
          description: "Project for managedRuntime tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest(
    "creates a code step definition with a managed runtime",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildCodePayload(parseUuidV7(project.id)),
            environment: {
              kind: "inline",
              runtime: { kind: "managed", id: "bun1" },
            },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.environment).toEqual({
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
      });
      expect("executionMode" in stepDefinition).toBe(false);
    },
  );

  concurrentTest(
    "defaults environment to null when it is omitted",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          buildCodePayload(parseUuidV7(project.id)),
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.environment).toBeNull();
    },
  );

  concurrentTest("returns 422 for an unknown identifier", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const { data, error } = await apiClient.api["step-definitions"].post(
      {
        ...buildCodePayload(parseUuidV7(project.id)),
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "nope" as never },
        },
      },
      { headers: { ...authHeaders } },
    );

    expect(data).toBeNull();
    expectValidationError(error);
  });

  concurrentTest(
    "creates an agent step definition with a managed runtime",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildAgentPayload(parseUuidV7(project.id)),
            environment: {
              kind: "inline",
              runtime: { kind: "managed", id: "bun1" },
            },
            repo: { mode: "readOnly" as const },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.environment).toEqual({
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
      });
      expect(stepDefinition.repo.mode).toBe("readOnly");
    },
  );

  concurrentTest(
    "returns 422 together with a devcontainerConfigPath",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].post(
        {
          ...buildCodePayload(parseUuidV7(project.id)),
          environment: {
            kind: "inline",
            runtime: {
              kind: "managed",
              id: "bun1",
              ...{ config: ".devcontainer/alt/devcontainer.json" },
            },
          },
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expectValidationError(error);
    },
  );

  concurrentTest(
    "returns 422 for managed runtime details on host",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].post(
        {
          ...buildCodePayload(parseUuidV7(project.id)),
          environment: {
            kind: "inline",
            runtime: { kind: "host", ...{ id: "bun1" } },
          },
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expectValidationError(error);
    },
  );

  concurrentTest(
    "upsert sets, switches, then clears the managed runtime when it is omitted",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = buildCodePayload(parseUuidV7(project.id));
      const created = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          {
            ...payload,
            environment: {
              kind: "inline",
              runtime: { kind: "managed", id: "bun1" },
            },
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(created.environment).toEqual({
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
      });

      const switched = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          {
            ...payload,
            environment: {
              kind: "inline",
              runtime: { kind: "managed", id: "node24" },
            },
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(switched.id).toBe(created.id);
      expect(switched.environment).toEqual({
        kind: "inline",
        runtime: { kind: "managed", id: "node24" },
      });

      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get(
          {
            headers: { ...authHeaders },
          },
        ),
      );
      expect(reloaded.environment).toEqual(switched.environment);

      const cleared = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, {
          headers: { ...authHeaders },
        }),
      );
      expect(cleared.id).toBe(created.id);
      expect(cleared.environment).toBeNull();
    },
  );

  concurrentTest(
    "upsert rejects adding a managed runtime to a step that keeps its config path",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = {
        ...buildCodePayload(parseUuidV7(project.id)),
        environment: {
          kind: "inline" as const,
          runtime: {
            kind: "devcontainer" as const,
            config: ".devcontainer/alt/devcontainer.json",
          },
        },
      };
      await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, {
          headers: { ...authHeaders },
        }),
      );

      const { data, error } = await apiClient.api["step-definitions"].put(
        {
          ...payload,
          environment: {
            ...payload.environment,
            runtime: { ...payload.environment.runtime, ...{ id: "node24" } },
          },
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expectValidationError(error);
    },
  );
});
