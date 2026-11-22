import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { assertStepKindFitsRuntime } from "@/pipeline-definitions/step-definition/domain/assert-step-kind-fits-runtime";
import { taskKindForStepDefinitionKind } from "@/pipeline-definitions/step-definition/domain/build-task-instructions-from-step-definition";
import {
  StepDefinitionEntity,
  assertToolCallFitsMcpServers,
  type CreateStepDefinitionEntityProps,
  type StepDefinitionToolCall,
} from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { concurrentTest } from "tests/utils";

const expectCoreValidationCode = (fn: () => void, code: string) => {
  expect(fn).toThrow(CoreValidationError);
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    expect((error as CoreValidationError).code).toBe(code);
  }
};

const toolCall = (): StepDefinitionToolCall => ({
  server: "notion",
  tool: "search",
  argsTemplate: { query: "{{input.query}}", limit: 5 },
  toolSchemas: {
    input: { type: "object", properties: { query: { type: "string" } } },
    output: null,
  },
});

function mcpToolProps(): CreateStepDefinitionEntityProps {
  return {
    projectId: createUuidV7(),
    key: "notion-search",
    name: "Notion search",
    prompt: null,
    version: 1,
    kind: "mcp_tool",
    toolCallJson: toolCall(),
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    taskExecutionConfigId: createUuidV7(),
    status: "active",
  };
}

describe("step definition entity: kind 'mcp_tool'", () => {
  concurrentTest("creates with a tool call and round-trips it", () => {
    const entity = StepDefinitionEntity.create(mcpToolProps());

    expect(entity.kind).toBe("mcp_tool");
    expect(entity.prompt).toBeNull();
    expect(entity.entrypointJson).toBeNull();
    expect(entity.toolCallJson).toEqual(toolCall());
    expect(
      StepDefinitionEntity.rehydrate(entity.toJSON()).toolCallJson,
    ).toEqual(toolCall());
  });

  concurrentTest("requires a tool call", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({ ...mcpToolProps(), toolCallJson: null }),
      "STEP_DEFINITION_TOOL_CALL_REQUIRED",
    );
  });

  concurrentTest.each([
    ["server", { ...toolCall(), server: " " }],
    ["tool", { ...toolCall(), tool: "" }],
  ] as const)("rejects a tool call with an empty %s", (_field, value) => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({ ...mcpToolProps(), toolCallJson: value }),
      "STEP_DEFINITION_TOOL_CALL_INVALID",
    );
  });

  concurrentTest("rejects a prompt", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...mcpToolProps(),
          prompt: "Do the thing",
        }),
      "STEP_DEFINITION_PROMPT_NOT_ALLOWED",
    );
  });

  concurrentTest("rejects an entrypoint", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...mcpToolProps(),
          entrypointJson: { sourceFile: "step.ts" },
        }),
      "STEP_DEFINITION_ENTRYPOINT_NOT_ALLOWED",
    );
  });

  concurrentTest("requires a result schema", () => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...mcpToolProps(),
          resultSchemaJson: null,
        }),
      "STEP_DEFINITION_RESULT_SCHEMA_REQUIRED",
    );
  });

  concurrentTest.each([
    ["user_defined", { prompt: "Do the thing" }],
    ["code", { entrypointJson: { sourceFile: "step.ts" } }],
    ["built_in", {}],
  ] as const)("rejects a tool call on a '%s' step", (kind, extra) => {
    expectCoreValidationCode(
      () =>
        StepDefinitionEntity.create({
          ...mcpToolProps(),
          ...extra,
          kind,
        }),
      "STEP_DEFINITION_TOOL_CALL_NOT_ALLOWED",
    );
  });

  concurrentTest("is queued as an mcp_tool Task", () => {
    expect(taskKindForStepDefinitionKind("mcp_tool")).toBe("mcp_tool");
  });
});

describe("assertToolCallFitsMcpServers", () => {
  concurrentTest("accepts exactly the server the tool call names", () => {
    expect(() => {
      assertToolCallFitsMcpServers("mcp_tool", toolCall(), ["notion"]);
    }).not.toThrow();
  });

  concurrentTest.each([[[]], [["github"]], [["notion", "github"]]])(
    "rejects the servers %p",
    (servers) => {
      expectCoreValidationCode(() => {
        assertToolCallFitsMcpServers("mcp_tool", toolCall(), servers);
      }, "STEP_DEFINITION_TOOL_CALL_SERVER_MISMATCH");
    },
  );

  concurrentTest("ignores other kinds", () => {
    expect(() => {
      assertToolCallFitsMcpServers("user_defined", null, ["a", "b"]);
    }).not.toThrow();
  });
});

describe("assertStepKindFitsRuntime: kind 'mcp_tool'", () => {
  concurrentTest.each([
    { kind: "host" },
    { kind: "managed", id: "bun1" },
    { kind: "devcontainer" },
  ] as const)("allows the %p runtime", (runtime) => {
    expect(() => {
      assertStepKindFitsRuntime("mcp_tool", runtime);
    }).not.toThrow();
  });
});
