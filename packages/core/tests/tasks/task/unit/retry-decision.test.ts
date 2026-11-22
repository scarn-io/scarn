import { describe, expect, test } from "bun:test";
import {
  errorMatches,
  isNeverRetried,
  retryDecision,
  retryPolicy,
} from "@/tasks/task/domain/retry-decision";
import { namedRunError } from "@/tasks/task/domain/run-error";

describe("errorMatches", () => {
  test.concurrent("matches a listed name or Scarn.All", () => {
    expect(errorMatches(["MergeConflict"], "MergeConflict")).toBe(true);
    expect(errorMatches(["Scarn.All"], "Anything")).toBe(true);
    expect(errorMatches(["MergeConflict"], "Scarn.Timeout")).toBe(false);
  });
});

describe("retryDecision", () => {
  const policy = [
    { on: ["MergeConflict"], maxAttempts: 2 },
    { on: ["Scarn.All"], maxAttempts: 1 },
  ];

  test.concurrent("no policy never retries", () => {
    expect(retryDecision(null, { name: "MergeConflict" }, 0)).toEqual({
      retry: false,
    });
  });

  test.concurrent("a matching entry retries until maxAttempts", () => {
    const error = { name: "MergeConflict" };
    expect(retryDecision(policy, error, 0).retry).toBe(true);
    expect(retryDecision(policy, error, 1).retry).toBe(true);
    expect(retryDecision(policy, error, 2).retry).toBe(false);
  });

  test.concurrent(
    "the first matching entry decides; Scarn.All catches the rest",
    () => {
      const error = { name: "Scarn.Timeout" };
      expect(retryDecision(policy, error, 0).retry).toBe(true);
      expect(retryDecision(policy, error, 1).retry).toBe(false);
    },
  );

  test.concurrent("an unnamed error isn't retried", () => {
    expect(
      retryDecision(
        [{ on: ["MergeConflict"], maxAttempts: 3 }],
        { name: "Scarn.StepFailed" },
        0,
      ).retry,
    ).toBe(false);
  });

  test.concurrent("maxAttempts 0 never retries", () => {
    expect(
      retryDecision([{ on: ["Scarn.All"], maxAttempts: 0 }], { name: "X" }, 0)
        .retry,
    ).toBe(false);
  });

  test.concurrent.each([
    "ManagedConnectionAuthorityLost",
    "ManagedConnectionNotReady",
  ])("a Scarn.All or named policy never retries %s", (name) => {
    expect(
      retryDecision([{ on: ["Scarn.All"], maxAttempts: 3 }], { name }, 0),
    ).toEqual({ retry: false });
    expect(
      retryDecision([{ on: [name], maxAttempts: 3 }], { name }, 0).retry,
    ).toBe(false);
  });

  test.concurrent("a run left with an unknown operation never retries", () => {
    const all = [{ on: ["Scarn.All"], maxAttempts: 3 }];
    expect(
      retryDecision(all, { name: "Scarn.Timeout", operationUnknown: true }, 0)
        .retry,
    ).toBe(false);
    expect(
      retryDecision(all, { name: "Scarn.Timeout", operationUnknown: false }, 0)
        .retry,
    ).toBe(true);
  });

  test.concurrent("isNeverRetried names only the server-owned cases", () => {
    expect(isNeverRetried({ name: "ManagedConnectionAuthorityLost" })).toBe(
      true,
    );
    expect(isNeverRetried({ name: "ManagedConnectionNotReady" })).toBe(true);
    expect(
      isNeverRetried({
        name: "Scarn.HeartbeatTimeout",
        operationUnknown: true,
      }),
    ).toBe(true);
    expect(isNeverRetried({ name: "Scarn.StepFailed" })).toBe(false);
  });

  test.concurrent("malformed entries are ignored", () => {
    expect(
      retryPolicy([{ on: "X" }, 3, { on: ["X"], maxAttempts: 1 }]),
    ).toEqual([{ on: ["X"], maxAttempts: 1 }]);
  });
});

describe("namedRunError", () => {
  test.concurrent.each([
    ["timeout", { code: "TASK_TIMED_OUT" }, "Scarn.Timeout"],
    ["abandoned", { code: "TASK_ABANDONED" }, "Scarn.HeartbeatTimeout"],
    ["failed", { name: "MergeConflict" }, "MergeConflict"],
    ["failed", { code: "SCARN_WORKER_EXECUTION_FAILED" }, "Scarn.StepFailed"],
    ["failed", null, "Scarn.StepFailed"],
  ] as const)("a %s run with %j is named %s", (status, errorJson, name) => {
    expect(namedRunError({ status, errorJson }).name).toBe(name);
  });
});
