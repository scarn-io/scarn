import { describe, expect } from "bun:test";
import { readStoredTaskRun } from "@/tasks/task-run/contracts/task-run-stored";
import { namedRunError } from "@/tasks/task/domain/run-error";
import { concurrentTest } from "tests/utils";
import v1FailedRun from "../fixtures/v1-failed-run.json";
import v1SucceededRun from "../fixtures/v1-succeeded-run.json";
import v1TimeoutRun from "../fixtures/v1-timeout-run.json";

describe("task_runs stored reader", () => {
  for (const [name, fixture] of [
    ["succeeded", v1SucceededRun],
    ["failed", v1FailedRun],
    ["timeout", v1TimeoutRun],
  ] as const) {
    concurrentTest(`reads the ${name} fixture`, () => {
      expect(readStoredTaskRun(fixture) as unknown).toEqual({
        success: true,
        value: { resultJson: fixture.resultJson, errorJson: fixture.errorJson },
      });
    });
  }

  concurrentTest("the pinned error keys name a failed run", () => {
    const read = readStoredTaskRun(v1FailedRun);
    expect(
      read.success &&
        namedRunError({ status: "failed", errorJson: read.value.errorJson }),
    ).toEqual({
      name: v1FailedRun.errorJson.name,
      message: v1FailedRun.errorJson.message,
    });
  });

  concurrentTest("reads an error the worker reported as any JSON", () => {
    for (const errorJson of ["plain text", 42, ["a"], { name: 7 }]) {
      expect(readStoredTaskRun({ resultJson: null, errorJson }).success).toBe(
        true,
      );
    }
  });

  concurrentTest("a missing column is unreadable", () => {
    expect(readStoredTaskRun({ resultJson: null } as never).success).toBe(
      false,
    );
  });
});
