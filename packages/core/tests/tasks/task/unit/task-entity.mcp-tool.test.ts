import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import {
  McpToolTaskRunEntity,
  type TaskToolCall,
} from "@/tasks/task-run/domain/task-run-entity";
import { NOW } from "./on-run-ended-fixtures";

const toolCall = (): TaskToolCall => ({
  server: "notion",
  tool: "search",
  argsTemplate: { query: "{{input.query}}" },
  toolSchemas: { input: { type: "object" }, output: null },
});

const create = (
  overrides: Partial<Parameters<typeof TaskEntity.create>[0]> = {},
) =>
  TaskEntity.create({
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    kind: "mcp_tool",
    toolCallJson: toolCall(),
    status: "queued",
    createdAt: NOW,
    ...overrides,
  });

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

describe("an mcp_tool Task", () => {
  test.concurrent("keeps its tool call and gives it to its runs", () => {
    const task = create();

    expect(task.toolCallJson).toEqual(toolCall());
    expect(task.toJSON().toolCallJson).toEqual(toolCall());

    const run = task.newRun({
      number: 1,
      reason: "initial",
      status: "queued",
      now: NOW,
    });
    expect(run).toBeInstanceOf(McpToolTaskRunEntity);
    expect(run.kind === "mcp_tool" && run.toolCallJson).toEqual(toolCall());
    expect(run.toJSON()).toMatchObject({
      prompt: null,
      entrypointJson: null,
      toolCallJson: toolCall(),
    });
  });

  test.concurrent("requires a tool call", () => {
    expectValidationCode(
      () => create({ toolCallJson: null }),
      "TASK_TOOL_CALL_REQUIRED",
    );
  });

  test.concurrent("rejects a prompt", () => {
    expectValidationCode(
      () => create({ prompt: "Do the thing" }),
      "TASK_PROMPT_NOT_ALLOWED",
    );
  });

  test.concurrent("rejects an entrypoint", () => {
    expectValidationCode(
      () => create({ entrypointJson: { sourceFile: "steps/run.ts" } }),
      "TASK_ENTRYPOINT_NOT_ALLOWED",
    );
  });

  test.concurrent.each([
    ["agent", { prompt: "Do the thing" }],
    ["code", { entrypointJson: { sourceFile: "steps/run.ts" } }],
  ] as const)("rejects a tool call on a '%s' Task", (kind, extra) => {
    expectValidationCode(
      () => create({ kind, ...extra }),
      "TASK_TOOL_CALL_NOT_ALLOWED",
    );
  });
});
