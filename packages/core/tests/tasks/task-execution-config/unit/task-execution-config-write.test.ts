import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import type { TaskExecutionConfigContentInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { concurrentTest } from "tests/utils";

const create = (content: Partial<TaskExecutionConfigContentInput>) =>
  TaskExecutionConfigEntity.create({
    projectId: createUuidV7(),
    content: {
      environment: null,
      git: null,
      mcp: null,
      healthChecks: null,
      ...content,
    },
  });

const assertInvalid = (content: Partial<TaskExecutionConfigContentInput>) => {
  try {
    create(content);
    throw new Error("expected an invalid execution config");
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    if (!(error instanceof CoreValidationError)) throw error;
    expect(error.code).toBe("TASK_EXECUTION_CONFIG_INVALID");
  }
};

describe("task execution config write schemas", () => {
  for (const [name, runtime] of [
    ["removed runtime none", { kind: "none" }],
    ["unknown runtime field", { kind: "host", config: "x" }],
    ["unknown managed runtime", { kind: "managed", id: "python3" }],
    [
      "devcontainer path outside the rules",
      { kind: "devcontainer", config: "../devcontainer.json" },
    ],
  ] as const) {
    concurrentTest(`rejects ${name}`, () => {
      assertInvalid({
        environment: { kind: "inline", runtime: runtime as never },
      });
    });
  }

  concurrentTest("rejects a static secret env value", () => {
    assertInvalid({
      environment: {
        kind: "inline",
        vars: [{ name: "TOKEN", source: "value", value: "abc", secret: true }],
      },
    });
  });

  concurrentTest("rejects duplicate env var names", () => {
    const entry = {
      name: "A",
      source: "value",
      value: "1",
      secret: false,
    } as const;
    assertInvalid({ environment: { kind: "inline", vars: [entry, entry] } });
  });

  concurrentTest("rejects optional on every MCP server type", () => {
    for (const server of [
      { type: "ref", optional: true },
      { type: "local", command: ["db"], optional: true },
      { type: "remote", url: "https://mcp.linear.app/mcp", optional: true },
    ]) {
      assertInvalid({ mcp: { db: server as never } });
    }
  });
});
