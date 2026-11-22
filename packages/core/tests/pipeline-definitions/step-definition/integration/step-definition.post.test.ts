import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

const buildCreateStepDefinitionPayload = (projectId: UuidV7) => ({
  projectId,
  key: `description_quality_${crypto.randomUUID()}`,
  name: "Description quality",
  description: "Reusable AI quality scoring step",
  prompt: "Score the description and return a typed result.",
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
      environment: {
        PLAYWRIGHT_HEADLESS: "{env:PLAYWRIGHT_HEADLESS}",
      },
      disabled: false,
    },
  },
  status: "draft" as const,
  errors: ["Unclear", "MissingReproSteps"],
});

describe("step definition post endpoint", () => {
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
      email: `step-definition-post-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Step Definition Post Project",
          description: "Project for step definition post tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  concurrentTest(
    "creates a step definition with extractors and computed signals but no policy ownership",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.errors).toEqual(["Unclear", "MissingReproSteps"]);
      expect(stepDefinition.prompt).toBe(
        "Score the description and return a typed result.",
      );
      expect(stepDefinition.opencodeMcpJson).toEqual({
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp@0.0.68"],
          environment: {
            PLAYWRIGHT_HEADLESS: "{env:PLAYWRIGHT_HEADLESS}",
          },
          disabled: false,
        },
      });
      expect(stepDefinition.healthChecksJson).toBeNull();
      expect(stepDefinition.environment).toBeNull();
      expect("jsonRulesEnginePolicyDefinition" in stepDefinition).toBe(false);
    },
  );

  concurrentTest("creates a step definition with envJson", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const envJson = [
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
    ];

    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
          environment: { kind: "inline", envJson },
        },
        { headers: { ...authHeaders } },
      ),
    );

    expect(stepDefinition.environment).toEqual({ kind: "inline", envJson });
  });

  concurrentTest("returns 422 for invalid envJson entry", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const { data, error } = await apiClient.api["step-definitions"].post(
      {
        ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
        environment: {
          kind: "inline",
          envJson: [
            {
              name: "SCARN_TOKEN",
              source: "value" as const,
              value: "x",
              secret: false,
              applies: "agent" as const,
            },
          ],
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
    "creates a step definition with healthChecksJson, applying severity/timeoutSeconds defaults",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
            healthChecksJson: [
              {
                mcp: "playwright",
                tool: "browser_navigate",
                args: { url: "about:blank" },
              },
              { tool: "flaky_tool", severity: "warn", timeoutSeconds: 5 },
            ],
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(stepDefinition.healthChecksJson).toEqual([
        {
          kind: "tool",
          mcp: "playwright",
          tool: "browser_navigate",
          args: { url: "about:blank" },
          severity: "required",
          timeoutSeconds: 15,
        },
        {
          kind: "tool",
          tool: "flaky_tool",
          severity: "warn",
          timeoutSeconds: 5,
        },
      ]);
    },
  );

  concurrentTest("returns 422 for invalid healthChecksJson entry", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const { data, error } = await apiClient.api["step-definitions"].post(
      {
        ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
        healthChecksJson: [{ severity: "sometimes" }],
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
    "returns 422 for invalid local MCP server config",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].post(
        {
          ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
          opencodeMcpJson: {
            broken: {
              type: "local",
              command: [],
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
    },
  );

  concurrentTest("returns 422 when prompt is null", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const { data, error } = await apiClient.api["step-definitions"].post(
      {
        ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
        prompt: null,
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
    "returns 422 for invalid remote MCP server config",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }

      const { data, error } = await apiClient.api["step-definitions"].post(
        {
          ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
          opencodeMcpJson: {
            hosted: {
              type: "remote",
              url: "https://example.com/mcp",
              oauth: {
                clientId: "abc",
                extra: "invalid",
              },
            },
          },
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
    },
  );

  concurrentTest("returns 422 for a v1-shaped MCP server entry", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const v1Entry = { enabled: true, command: ["npx"] } as unknown as {
      type: "local";
      command: string[];
    };
    const { data, error } = await apiClient.api["step-definitions"].post(
      {
        ...buildCreateStepDefinitionPayload(parseUuidV7(project.id)),
        opencodeMcpJson: { datadog: v1Entry },
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
});
