import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import {
  McpToolTaskRunEntity,
  TaskRunEntity,
  type TaskToolCall,
} from "@/tasks/task-run/domain/task-run-entity";
import { concurrentTest } from "tests/utils";

const toolCall = (overrides: Partial<TaskToolCall> = {}): TaskToolCall => ({
  server: "notion",
  tool: "search",
  argsTemplate: { query: "{{input.query}}" },
  toolSchemas: { input: { type: "object" }, output: null },
  ...overrides,
});

const baseProps = () => ({
  taskId: createUuidV7(),
  number: 1,
  reason: "initial" as const,
  projectId: createUuidV7(),
  workItemId: createUuidV7(),
  taskExecutionConfigId: createUuidV7(),
  status: "queued" as const,
  evaluatedAt: new Date("2026-05-01T10:00:00.000Z"),
});

const row = () => ({ ...baseProps(), id: createUuidV7() });

const expectValidationCode = (build: () => unknown, code: string) => {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    expect((error as CoreValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected CoreValidationError ${code}`);
};

describe("McpToolTaskRunEntity", () => {
  concurrentTest("is created from a tool call", () => {
    const run = TaskRunEntity.create({
      ...baseProps(),
      kind: "mcp_tool",
      toolCallJson: toolCall(),
    });

    expect(run).toBeInstanceOf(McpToolTaskRunEntity);
    expect(run.kind === "mcp_tool" && run.toolCallJson).toEqual(toolCall());
    expect(run.toJSON()).toMatchObject({
      kind: "mcp_tool",
      prompt: null,
      entrypointJson: null,
      toolCallJson: toolCall(),
    });
  });

  concurrentTest("keeps its tool call across transitions", () => {
    const run = McpToolTaskRunEntity.create({
      ...baseProps(),
      toolCallJson: toolCall(),
    });
    const completed = run.complete(
      "succeeded",
      new Date("2026-05-01T10:01:00.000Z"),
      { resultJson: { ok: true } },
    );

    expect(completed).toBeInstanceOf(McpToolTaskRunEntity);
    expect(completed.toolCallJson).toEqual(toolCall());
  });

  concurrentTest("rejects a tool call with a blank server or tool", () => {
    expectValidationCode(
      () =>
        McpToolTaskRunEntity.create({
          ...baseProps(),
          toolCallJson: toolCall({ tool: " " }),
        }),
      "TASK_TOOL_CALL_REQUIRED",
    );
  });

  describe("rehydrating a flat row", () => {
    concurrentTest("round-trips through toJSON", () => {
      const run = McpToolTaskRunEntity.create({
        ...baseProps(),
        toolCallJson: toolCall(),
      });

      const rehydrated = TaskRunEntity.rehydrate(run.toJSON());

      expect(rehydrated).toBeInstanceOf(McpToolTaskRunEntity);
      expect(rehydrated.toJSON()).toEqual(run.toJSON());
    });

    concurrentTest("rejects an mcp_tool row without a tool call", () => {
      expectValidationCode(
        () => TaskRunEntity.rehydrate({ ...row(), kind: "mcp_tool" }),
        "TASK_TOOL_CALL_REQUIRED",
      );
    });

    concurrentTest.each([
      ["a prompt", { prompt: "Do it" }, "TASK_PROMPT_NOT_ALLOWED"],
      [
        "an entrypoint",
        { entrypointJson: { sourceFile: "steps/run.ts" } },
        "TASK_ENTRYPOINT_NOT_ALLOWED",
      ],
    ] as const)("rejects an mcp_tool row with %s", (_name, extra, code) => {
      expectValidationCode(
        () =>
          TaskRunEntity.rehydrate({
            ...row(),
            kind: "mcp_tool",
            toolCallJson: toolCall(),
            ...extra,
          }),
        code,
      );
    });

    concurrentTest("rejects a code row with a tool call", () => {
      expectValidationCode(
        () =>
          TaskRunEntity.rehydrate({
            ...row(),
            kind: "code",
            entrypointJson: { sourceFile: "steps/run.ts" },
            toolCallJson: toolCall(),
          }),
        "TASK_TOOL_CALL_NOT_ALLOWED",
      );
    });
  });
});
