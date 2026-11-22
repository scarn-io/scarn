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

const codeOf = (build: () => void) => {
  try {
    build();
  } catch (error) {
    if (error instanceof CoreValidationError) return error.code;
    throw error;
  }
  return null;
};

describe("named task execution config writes", () => {
  concurrentTest("keep strict names and reject inline hybrids", () => {
    for (const environment of [
      { kind: "named", name: "../integration" },
      { kind: "named", name: "Integration" },
      { kind: "named", name: "integration", runtime: { kind: "host" } },
      { kind: "named", name: "integration", vars: [] },
      { kind: "named", name: "integration", envJson: [] },
      { kind: "named", name: "integration", branch: "main" },
    ]) {
      expect(
        codeOf(() =>
          create({
            environment:
              environment as TaskExecutionConfigContentInput["environment"],
          }),
        ),
      ).toBe("TASK_EXECUTION_CONFIG_INVALID");
    }
  });

  concurrentTest("still enforce MCP health-check ownership", () => {
    expect(
      codeOf(() =>
        create({
          environment: { kind: "named", name: "integration" },
          healthChecks: [{ kind: "tool", mcp: "missing", tool: "query" }],
        }),
      ),
    ).toBe("TASK_EXECUTION_CONFIG_HEALTH_CHECK_MCP_UNKNOWN");
    const config = create({
      environment: { kind: "named", name: "integration" },
      mcp: { db: { type: "ref", name: "postgres" } },
      healthChecks: [{ kind: "tool", mcp: "db", tool: "query" }],
    });
    expect(config.environment).toEqual({ kind: "named", name: "integration" });
  });
});
