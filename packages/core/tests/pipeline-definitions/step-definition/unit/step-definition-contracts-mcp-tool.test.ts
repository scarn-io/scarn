import { describe, expect } from "bun:test";
import {
  createStepDefinitionInputSchema,
  toolCallJsonSchema,
} from "@scarn/core/pipeline-definitions/step-definition/contracts/step-definition-contracts";
import { concurrentTest } from "tests/utils";

const projectId = "019a0000-0000-7000-8000-000000000000";

const toolCall = {
  server: "notion",
  tool: "search",
  argsTemplate: { query: "{{input.query}}", limit: 5 },
  toolSchemas: {
    input: { type: "object" },
    output: { type: "object", properties: { hits: { type: "array" } } },
  },
};

const mcpToolInput = (overrides: Record<string, unknown> = {}) => ({
  projectId,
  key: "notion-search",
  name: "Notion search",
  description: null,
  prompt: null,
  version: 1,
  kind: "mcp_tool" as const,
  toolCallJson: toolCall,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  opencodeMcpJson: {
    notion: { type: "remote", url: "https://mcp.notion.com/mcp" },
  },
  status: "active" as const,
  ...overrides,
});

const issuePaths = (input: ReturnType<typeof mcpToolInput>) => {
  const result = createStepDefinitionInputSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.error?.issues.map((issue) => issue.path.join(".")) ?? [];
};

describe("toolCallJsonSchema", () => {
  concurrentTest("accepts boolean tool schemas and any args template", () => {
    expect(
      toolCallJsonSchema.parse({
        ...toolCall,
        argsTemplate: "{{input}}",
        toolSchemas: { input: true, output: null },
      }).toolSchemas.input,
    ).toBe(true);
  });

  concurrentTest.each(["server", "tool"])("rejects an empty %s", (field) => {
    expect(
      toolCallJsonSchema.safeParse({ ...toolCall, [field]: " " }).success,
    ).toBe(false);
  });

  concurrentTest("rejects unknown fields", () => {
    expect(
      toolCallJsonSchema.safeParse({ ...toolCall, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("createStepDefinitionInputSchema: kind 'mcp_tool'", () => {
  concurrentTest("accepts a tool step and keeps its tool call", () => {
    expect(
      createStepDefinitionInputSchema.parse(mcpToolInput()).toolCallJson,
    ).toEqual(toolCall);
  });

  concurrentTest("requires a tool call", () => {
    expect(issuePaths(mcpToolInput({ toolCallJson: null }))).toContain(
      "toolCallJson",
    );
  });

  concurrentTest.each([
    ["no servers", null],
    ["another server", { github: { type: "remote", url: "https://x.test" } }],
    [
      "two servers",
      {
        notion: { type: "remote", url: "https://mcp.notion.com/mcp" },
        github: { type: "remote", url: "https://x.test" },
      },
    ],
  ])("rejects %s", (_label, opencodeMcpJson) => {
    expect(issuePaths(mcpToolInput({ opencodeMcpJson }))).toContain(
      "opencodeMcpJson",
    );
  });

  concurrentTest.each([
    ["prompt", { prompt: "Do it" }],
    ["entrypointJson", { entrypointJson: { sourceFile: "step.ts" } }],
    ["resultSchemaJson", { resultSchemaJson: null }],
    [
      "healthChecksJson",
      {
        healthChecksJson: [{ tool: "search", mcp: "notion" }],
      },
    ],
  ])("rejects a bad %s", (path, overrides) => {
    expect(issuePaths(mcpToolInput(overrides))).toContain(path);
  });

  concurrentTest("rejects a tool call on another kind", () => {
    expect(
      issuePaths(
        mcpToolInput({
          kind: "user_defined",
          prompt: "Do it",
          toolCallJson: toolCall,
        }),
      ),
    ).toContain("toolCallJson");
  });
});
