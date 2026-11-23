import { describe, expect } from "bun:test";
import type { HealthCheck } from "@/common/contracts/health-checks";
import { CoreValidationError } from "@/lib/errors";
import { createStepDefinitionInputSchema } from "@/pipeline-definitions/step-definition/contracts/step-definition-contracts";
import { assertHealthChecksFitStepKind } from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { concurrentTest } from "tests/utils";

const projectId = "019a0000-0000-7000-8000-000000000000";

const notionServers = {
  notion: { type: "remote", url: "https://mcp.notion.com/mcp" },
};

const notionSearchCheck: HealthCheck = {
  kind: "tool",
  tool: "search",
  mcp: "notion",
  severity: "required",
  timeoutSeconds: 15,
};

const cliCheck: HealthCheck = {
  kind: "cli",
  command: ["true"],
  expectExitCode: 0,
  severity: "required",
  timeoutSeconds: 15,
};

const flatToolCheck: HealthCheck = {
  kind: "tool",
  tool: "read",
  severity: "required",
  timeoutSeconds: 15,
};

const codeInput = (overrides: Record<string, unknown> = {}) => ({
  projectId,
  key: "notion-sync",
  name: "Notion sync",
  description: null,
  version: 1,
  kind: "code" as const,
  entrypointJson: { sourceFile: "steps/notion-sync.ts" },
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  opencodeMcpJson: notionServers,
  status: "active" as const,
  ...overrides,
});

const issuePaths = (input: ReturnType<typeof codeInput>) => {
  const result = createStepDefinitionInputSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
};

const expectCoreValidationCode = (fn: () => void, code: string) => {
  expect(fn).toThrow(CoreValidationError);
  try {
    fn();
  } catch (error) {
    expect((error as CoreValidationError).code).toBe(code);
  }
};

describe("createStepDefinitionInputSchema: kind 'code' with MCP servers", () => {
  concurrentTest("accepts servers and tool checks on them", () => {
    const parsed = createStepDefinitionInputSchema.parse(
      codeInput({ healthChecksJson: [notionSearchCheck] }),
    );

    expect({
      servers: Object.keys(parsed.opencodeMcpJson ?? {}),
      checks: parsed.healthChecksJson,
    }).toEqual({ servers: ["notion"], checks: [notionSearchCheck] });
  });

  concurrentTest.each([
    ["a cli check", cliCheck],
    ["a tool check with no MCP server", flatToolCheck],
  ])("rejects %s", (_label, check) => {
    expect(
      issuePaths(codeInput({ healthChecksJson: [notionSearchCheck, check] })),
    ).toEqual(["healthChecksJson.1"]);
  });

  concurrentTest("leaves other kinds' health checks alone", () => {
    expect(
      createStepDefinitionInputSchema.safeParse(
        codeInput({
          kind: "user_defined",
          prompt: "Do it",
          entrypointJson: null,
          healthChecksJson: [cliCheck, flatToolCheck],
        }),
      ).success,
    ).toBe(true);
  });
});

describe("assertHealthChecksFitStepKind", () => {
  concurrentTest("accepts a code step's tool checks on MCP servers", () => {
    expect(() => {
      assertHealthChecksFitStepKind("code", [notionSearchCheck]);
    }).not.toThrow();
  });

  concurrentTest.each([
    ["a cli check", cliCheck],
    ["a tool check with no MCP server", flatToolCheck],
  ])("rejects %s on a code step", (_label, check) => {
    expectCoreValidationCode(() => {
      assertHealthChecksFitStepKind("code", [notionSearchCheck, check]);
    }, "STEP_DEFINITION_HEALTH_CHECK_NOT_ALLOWED");
  });

  concurrentTest("ignores other kinds", () => {
    expect(() => {
      assertHealthChecksFitStepKind("user_defined", [cliCheck, flatToolCheck]);
    }).not.toThrow();
  });
});
