import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const createStepDefinitionPayload = (projectId: UuidV7) => ({
  projectId,
  key: `description_quality_${crypto.randomUUID()}`,
  name: "Description quality",
  description: "Reusable AI quality scoring step",
  prompt: "Review the ticket and return a typed result.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: {
    type: "object",
  },
  resultSchemaJson: {
    type: "object",
  },
  opencodeMcpJson: {
    playwright: {
      type: "local" as const,
      command: ["npx", "-y", "@playwright/mcp@0.0.68"],
      disabled: false,
      timeout: { catalog: 5_000, execution: 5_000 },
    },
    hosted: {
      type: "remote" as const,
      url: "https://example.com/mcp",
      headers: {
        authorization: "Bearer {env:EXAMPLE_TOKEN}",
      },
      oauth: { client_id: "client-id", scope: "read:all" },
    },
    datadog: {
      type: "local" as const,
      command: ["npx", "-y", "@winor30/mcp-server-datadog@1.7.0"],
      disabled: true,
    },
  },
  environment: {
    kind: "inline" as const,
    runtime: { kind: "host" as const },
    envJson: [
      {
        name: "ACCOUNT_ID",
        source: "value" as const,
        value: "{{input.accountId}}",
        secret: false,
        applies: "agent" as const,
      },
      {
        name: "WAREHOUSE_TOKEN",
        source: "inherit" as const,
        from: "WAREHOUSE_TOKEN",
        secret: true,
        optional: false,
        applies: "agent" as const,
      },
    ],
  },
  status: "draft" as const,
  errors: ["Unclear"],
});

describe("step definition lifecycle", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;
  let createPayload: ReturnType<typeof createStepDefinitionPayload> | undefined;

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-lifecycle-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Lifecycle Project",
          description: "Project for step definition lifecycle tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
    createPayload = createStepDefinitionPayload(parseUuidV7(project.id));
  });

  serialTest("creates a step definition with projectId", async () => {
    if (!project || !authHeaders || !createPayload) {
      throw new Error("Expected project auth setup to complete");
    }

    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(createPayload, {
        headers: { ...authHeaders },
      }),
    );

    stepDefinitionId = stepDefinition.id;

    expect(stepDefinition.projectId).toBe(project.id);
    expect(stepDefinition.status).toBe("draft");
    expect(stepDefinition.prompt).toBe(
      "Review the ticket and return a typed result.",
    );
    expect(stepDefinition.opencodeMcpJson).toEqual(
      createPayload.opencodeMcpJson,
    );
    expect(stepDefinition.environment).toEqual(createPayload.environment);
    expect(stepDefinition.repo).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    });
    expect("jsonRulesEnginePolicyDefinition" in stepDefinition).toBe(false);
  });

  serialTest("gets and lists step definitions by projectId", async () => {
    if (!stepDefinitionId || !authHeaders || !project) {
      throw new Error("Expected the step definition to be created first");
    }

    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"]({ stepDefinitionId }).get({
        headers: { ...authHeaders },
      }),
    );
    const listedStepDefinitions = await unwrapAsync(
      apiClient.api["step-definitions"].get({
        query: { projectId: parseUuidV7(project.id) },
        headers: { ...authHeaders },
      }),
    );

    expect(stepDefinition.id).toBe(stepDefinitionId);
    expect(stepDefinition.resultSchemaJson).toEqual({ type: "object" });
    expect(stepDefinition.opencodeMcpJson).toEqual(
      createPayload?.opencodeMcpJson ?? null,
    );
    expect(stepDefinition.environment).toEqual(
      createPayload?.environment ?? null,
    );
    expect(listedStepDefinitions.map((item) => item.id)).toContain(
      stepDefinitionId,
    );
    expect(
      listedStepDefinitions.find((item) => item.id === stepDefinitionId)
        ?.opencodeMcpJson,
    ).toEqual(createPayload?.opencodeMcpJson ?? null);
    expect(
      listedStepDefinitions.find((item) => item.id === stepDefinitionId)
        ?.environment,
    ).toEqual(createPayload?.environment ?? null);
  });

  serialTest("upserts a step definition by projectId+key", async () => {
    if (!stepDefinitionId || !authHeaders || !project || !createPayload) {
      throw new Error("Expected the step definition to be created first");
    }
    const tenantUrlEnv = [
      {
        name: "TENANT_URL",
        source: "value" as const,
        value: "https://{{input.tenant}}.example.com",
        secret: false,
        applies: "both" as const,
      },
    ];

    const upserted = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        {
          ...createPayload,
          name: "Updated description quality",
          prompt: "Use the prior context and return an updated typed result.",
          environment: {
            kind: "inline",
            runtime: {
              kind: "devcontainer",
              config: ".devcontainer/alt/devcontainer.json",
            },
            envJson: tenantUrlEnv,
          },
          opencodeMcpJson: {
            snapshot: {
              type: "remote",
              url: "https://example.com/updated-mcp",
              disabled: false,
              oauth: false,
              timeout: { execution: 10_000 },
            },
          },
          status: "active",
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(upserted.id).toBe(stepDefinitionId);
    expect(upserted.environment).toEqual({
      kind: "inline",
      runtime: {
        kind: "devcontainer",
        config: ".devcontainer/alt/devcontainer.json",
      },
      envJson: tenantUrlEnv,
    });
    expect(upserted.name).toBe("Updated description quality");
    expect(upserted.prompt).toBe(
      "Use the prior context and return an updated typed result.",
    );
    expect(upserted.opencodeMcpJson).toEqual({
      snapshot: {
        type: "remote",
        url: "https://example.com/updated-mcp",
        disabled: false,
        oauth: false,
        timeout: { execution: 10_000 },
      },
    });
    expect(upserted.status).toBe("active");
    expect(upserted.repo).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    });

    const reloaded = await unwrapAsync(
      apiClient.api["step-definitions"]({ stepDefinitionId }).get({
        headers: { ...authHeaders },
      }),
    );
    expect(reloaded.environment).toEqual(upserted.environment);
    expect(reloaded.repo).toEqual(upserted.repo);
  });

  serialTest("upsert without envJson clears the stored env", async () => {
    if (!stepDefinitionId || !authHeaders || !createPayload) {
      throw new Error("Expected the step definition to be created first");
    }

    const upserted = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        {
          ...createPayload,
          environment: { ...createPayload.environment, envJson: undefined },
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(upserted.id).toBe(stepDefinitionId);
    expect(upserted.environment).toEqual({
      kind: "inline",
      runtime: { kind: "host" },
    });
  });

  serialTest("upsert replaces the declared error names", async () => {
    if (!stepDefinitionId || !authHeaders || !createPayload) {
      throw new Error("Expected the step definition to be created first");
    }

    const upserted = await unwrapAsync(
      apiClient.api["step-definitions"].put(
        { ...createPayload, errors: ["Unclear", "MissingContext"] },
        { headers: { ...authHeaders } },
      ),
    );

    expect(upserted.id).toBe(stepDefinitionId);
    expect(upserted.errors).toEqual(["Unclear", "MissingContext"]);
  });

  serialTest("rejects duplicate error names", async () => {
    if (!authHeaders || !createPayload) {
      throw new Error("Expected project auth setup to complete");
    }

    const { data, error } = await apiClient.api["step-definitions"].put(
      { ...createPayload, errors: ["Unclear", "Unclear"] },
      { headers: { ...authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "STEP_DEFINITION_ERROR_NAMES_NOT_UNIQUE",
    });
  });

  serialTest("upsert with a new key creates a step definition", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const newPayload = createStepDefinitionPayload(parseUuidV7(project.id));
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].put(newPayload, {
        headers: { ...authHeaders },
      }),
    );

    expect(created.key).toBe(newPayload.key);
    expect(created.projectId).toBe(project.id);
    expect(created.environment).toEqual(newPayload.environment);
    expect(created.errors).toEqual(["Unclear"]);
  });

  serialTest("archives a step definition", async () => {
    if (!stepDefinitionId || !authHeaders) {
      throw new Error("Expected the step definition to be created first");
    }

    const archivedStepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"]({ stepDefinitionId }).archive.put(
        undefined,
        { headers: { ...authHeaders } },
      ),
    );

    expect(archivedStepDefinition.status).toBe("archived");
  });
});
