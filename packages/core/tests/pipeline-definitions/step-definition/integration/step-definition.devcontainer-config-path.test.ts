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
  key: `devcontainer_config_${crypto.randomUUID()}`,
  name: "Devcontainer config",
  description: null,
  prompt: "Run the build and return a typed result.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "draft" as const,
});

const ALT_CONFIG = ".devcontainer/alt/devcontainer.json";

describe("step definition devcontainerConfigPath", () => {
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
      email: `step-definition-devcontainer-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Devcontainer Project",
          description: "Project for devcontainerConfigPath tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
  });

  concurrentTest(
    "creates a step definition with a path, normalizing a leading ./",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildPayload(parseUuidV7(project.id)),
            environment: {
              kind: "inline",
              runtime: { kind: "devcontainer", config: `./${ALT_CONFIG}` },
            },
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.environment).toEqual({
        kind: "inline",
        runtime: { kind: "devcontainer", config: ALT_CONFIG },
      });
    },
  );

  for (const path of [
    "/etc/devcontainer.json",
    "../devcontainer.json",
    ".devcontainer\\devcontainer.json",
    ".devcontainer/alt/config.json",
  ]) {
    concurrentTest(`returns 422 for invalid path ${path}`, async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].post(
        {
          ...buildPayload(parseUuidV7(project.id)),
          environment: {
            kind: "inline",
            runtime: { kind: "devcontainer", config: path },
          },
        },
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

  concurrentTest("returns 422 for a path on host", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const { data, error } = await apiClient.api["step-definitions"].post(
      {
        ...buildPayload(parseUuidV7(project.id)),
        environment: {
          kind: "inline",
          runtime: {
            kind: "host",
            ...{ config: ".devcontainer/devcontainer.json" },
          },
        },
      },
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

  concurrentTest(
    "upsert sets, then clears the path when it is omitted",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const payload = buildPayload(parseUuidV7(project.id));
      const created = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, {
          headers: { ...authHeaders },
        }),
      );
      expect(created.environment).toBeNull();

      const withPath = await unwrapAsync(
        apiClient.api["step-definitions"].put(
          {
            ...payload,
            environment: {
              kind: "inline",
              runtime: { kind: "devcontainer", config: ALT_CONFIG },
            },
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(withPath.id).toBe(created.id);
      expect(withPath.environment).toEqual({
        kind: "inline",
        runtime: { kind: "devcontainer", config: ALT_CONFIG },
      });

      const reloaded = await unwrapAsync(
        apiClient.api["step-definitions"]({ stepDefinitionId: created.id }).get(
          {
            headers: { ...authHeaders },
          },
        ),
      );
      expect(reloaded.environment).toEqual(withPath.environment);

      const cleared = await unwrapAsync(
        apiClient.api["step-definitions"].put(payload, {
          headers: { ...authHeaders },
        }),
      );
      expect(cleared.environment).toBeNull();
    },
  );

  concurrentTest(
    "upsert rejects switching to host while keeping the path",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].put(
        {
          ...buildPayload(parseUuidV7(project.id)),
          environment: {
            kind: "inline",
            runtime: { kind: "host", ...{ config: ALT_CONFIG } },
          },
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
    },
  );
});
