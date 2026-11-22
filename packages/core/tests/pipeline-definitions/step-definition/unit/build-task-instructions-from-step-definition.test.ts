import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import {
  buildTaskInstructionsFromStepDefinition,
  taskKindForStepDefinitionKind,
} from "@/pipeline-definitions/step-definition/domain/build-task-instructions-from-step-definition";
import type { StepDefinitionKind } from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import { concurrentTest } from "tests/utils";

const stepDefinition = (
  overrides: Partial<
    Parameters<typeof buildTaskInstructionsFromStepDefinition>[0]
  > & {
    kind: StepDefinitionKind;
  },
) => ({
  id: createUuidV7(),
  prompt: null,
  resultSchemaJson: { type: "object" },
  entrypointJson: null,
  toolCallJson: null,
  taskExecutionConfigId: createUuidV7(),
  name: "Triage",
  ...overrides,
});

describe("buildTaskInstructionsFromStepDefinition", () => {
  concurrentTest("maps step definition kinds onto task kinds", () => {
    expect(taskKindForStepDefinitionKind("code")).toBe("code");
    expect(taskKindForStepDefinitionKind("user_defined")).toBe("agent");
    expect(taskKindForStepDefinitionKind("built_in")).toBe("agent");
    expect(taskKindForStepDefinitionKind("mcp_tool")).toBe("mcp_tool");
  });

  concurrentTest(
    "copies an agent step's prompt, result schema, config reference and name",
    () => {
      const resultSchemaJson = { type: "object" };
      const source = stepDefinition({
        kind: "user_defined",
        prompt: "Triage the ticket.",
        resultSchemaJson,
      });

      expect(buildTaskInstructionsFromStepDefinition(source)).toEqual({
        kind: "agent",
        prompt: "Triage the ticket.",
        resultSchemaJson,
        taskExecutionConfigId: source.taskExecutionConfigId,
        name: "Triage",
      });
    },
  );

  concurrentTest("copies a code step's entrypoint and drops any prompt", () => {
    const source = stepDefinition({
      kind: "code",
      entrypointJson: { sourceFile: "steps/triage.ts" },
    });

    expect(buildTaskInstructionsFromStepDefinition(source)).toEqual({
      kind: "code",
      resultSchemaJson: { type: "object" },
      entrypointJson: { sourceFile: "steps/triage.ts" },
      taskExecutionConfigId: source.taskExecutionConfigId,
      name: "Triage",
    });
  });

  concurrentTest("copies an mcp_tool step's tool call", () => {
    const toolCallJson = {
      server: "notion",
      tool: "search",
      argsTemplate: { query: "{{input.query}}" },
      toolSchemas: { input: { type: "object" }, output: null },
    };
    const source = stepDefinition({ kind: "mcp_tool", toolCallJson });

    expect(buildTaskInstructionsFromStepDefinition(source)).toEqual({
      kind: "mcp_tool",
      resultSchemaJson: { type: "object" },
      toolCallJson,
      taskExecutionConfigId: source.taskExecutionConfigId,
      name: "Triage",
    });
  });

  concurrentTest("carries a null config reference through", () => {
    const source = stepDefinition({
      kind: "user_defined",
      prompt: "Triage the ticket.",
      taskExecutionConfigId: null,
    });

    expect(
      buildTaskInstructionsFromStepDefinition(source).taskExecutionConfigId,
    ).toBeNull();
  });

  concurrentTest("rejects an agent-kind step definition with no prompt", () => {
    const source = stepDefinition({ kind: "built_in" });

    try {
      buildTaskInstructionsFromStepDefinition(source);
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "STEP_DEFINITION_PROMPT_REQUIRED_FOR_TASK",
      );
      return;
    }
    throw new Error("Expected STEP_DEFINITION_PROMPT_REQUIRED_FOR_TASK");
  });

  concurrentTest(
    "rejects a code-kind step definition with no entrypoint",
    () => {
      const source = stepDefinition({ kind: "code" });

      try {
        buildTaskInstructionsFromStepDefinition(source);
      } catch (error) {
        expect(error).toBeInstanceOf(CoreValidationError);
        expect((error as CoreValidationError).code).toBe(
          "STEP_DEFINITION_ENTRYPOINT_REQUIRED_FOR_TASK",
        );
        return;
      }
      throw new Error("Expected STEP_DEFINITION_ENTRYPOINT_REQUIRED_FOR_TASK");
    },
  );

  concurrentTest(
    "rejects an mcp_tool-kind step definition with no tool call",
    () => {
      const source = stepDefinition({ kind: "mcp_tool" });

      try {
        buildTaskInstructionsFromStepDefinition(source);
      } catch (error) {
        expect(error).toBeInstanceOf(CoreValidationError);
        expect((error as CoreValidationError).code).toBe(
          "STEP_DEFINITION_TOOL_CALL_REQUIRED_FOR_TASK",
        );
        return;
      }
      throw new Error("Expected STEP_DEFINITION_TOOL_CALL_REQUIRED_FOR_TASK");
    },
  );
});
