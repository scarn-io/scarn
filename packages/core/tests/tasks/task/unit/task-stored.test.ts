import { describe, expect } from "bun:test";
import {
  CURRENT_TASK_SCHEMA_VERSION,
  readStoredTask,
  readStoredTaskInstructions,
} from "@/tasks/task/contracts/task-stored";
import { concurrentTest } from "tests/utils";
import {
  storedTaskFixtures,
  type StoredTaskFixture,
} from "../integration/stored-task-fixtures";

const columnsOf = (fixture: StoredTaskFixture) => ({
  ...fixture,
  grants: fixture.grantsJson,
});

describe("tasks stored reader", () => {
  for (const [name, fixture] of Object.entries(storedTaskFixtures)) {
    concurrentTest(`reads the v1 ${name} fixture`, () => {
      expect(fixture.schemaVersion).toBe(CURRENT_TASK_SCHEMA_VERSION);
      const read = readStoredTask(fixture.schemaVersion, columnsOf(fixture));
      expect(read as unknown).toEqual({
        success: true,
        value: {
          entrypointJson: fixture.entrypointJson,
          toolCallJson: fixture.toolCallJson,
          resultSchemaJson: fixture.resultSchemaJson,
          inputJson: fixture.inputJson,
          retryJson: fixture.retryJson,
          environmentSelection:
            fixture.environmentSelectionJson === null
              ? null
              : {
                  extraConnectors: (
                    fixture.environmentSelectionJson as {
                      extraConnectors: unknown;
                    }
                  ).extraConnectors,
                },
          grants: fixture.grantsJson,
          resultJson: fixture.resultJson,
          errorJson: fixture.errorJson,
        },
      });
      expect(
        readStoredTaskInstructions(fixture.schemaVersion, fixture) as unknown,
      ).toEqual({
        success: true,
        value: {
          entrypointJson: fixture.entrypointJson,
          toolCallJson: fixture.toolCallJson,
          resultSchemaJson: fixture.resultSchemaJson,
          inputJson: fixture.inputJson,
        },
      });
    });
  }

  concurrentTest(
    "keeps a pipeline node's retry delays and an error's extra keys",
    () => {
      const read = readStoredTask(1, columnsOf(storedTaskFixtures.agent));
      expect(read.success && read.value.retryJson).toEqual([
        {
          on: ["Scarn.StepFailed"],
          maxAttempts: 2,
          intervalSeconds: 5,
          backoffRate: 2,
        },
      ]);
      const failed = readStoredTask(1, columnsOf(storedTaskFixtures.failed));
      expect(failed.success && failed.value.errorJson).toMatchObject({
        code: "SCARN_WORKER_EXECUTION_FAILED",
        cause: { exitCode: 1 },
      });
    },
  );

  concurrentTest("reads grants today's write rules would refuse", () => {
    const grantsJson = [
      { resource: "workItem", action: "read", scope: "self" },
      { resource: "workItem", action: "read", scope: "self" },
      { resource: "workItem", action: "retired_action", scope: "self" },
    ];
    const read = readStoredTask(1, {
      ...columnsOf(storedTaskFixtures.code),
      grants: grantsJson,
    });
    expect(read.success && (read.value.grants as unknown)).toEqual(grantsJson);
  });

  concurrentTest("an error without a message is unreadable", () => {
    const read = readStoredTask(1, {
      ...columnsOf(storedTaskFixtures.failed),
      errorJson: { name: "Scarn.StepFailed" },
    });
    expect(read.success).toBe(false);
  });

  concurrentTest(
    "an unreadable environment selection makes the row unreadable",
    () => {
      const read = readStoredTask(1, {
        ...columnsOf(storedTaskFixtures.agent),
        environmentSelectionJson: { schemaVersion: 99, extraConnectors: [] },
      });
      expect(read.success).toBe(false);
    },
  );

  concurrentTest("a broken tool call is unreadable", () => {
    const columns = {
      ...columnsOf(storedTaskFixtures["mcp-tool"]),
      toolCallJson: { server: "inventory" },
    };
    expect(readStoredTask(1, columns).success).toBe(false);
    expect(readStoredTaskInstructions(1, columns).success).toBe(false);
  });

  concurrentTest("an unknown schema version is unreadable", () => {
    const fixture = storedTaskFixtures.agent as StoredTaskFixture;
    expect(readStoredTask(99, columnsOf(fixture))).toEqual({
      success: false,
      reason: "unknown schema_version 99 (current is 1)",
    });
    expect(readStoredTaskInstructions(99, fixture).success).toBe(false);
  });
});
