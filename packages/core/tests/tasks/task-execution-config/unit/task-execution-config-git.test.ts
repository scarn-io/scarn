import { describe, expect } from "bun:test";
import {
  repoConfigInputSchema,
  resolveRepoConfig,
} from "@/common/contracts/repo-config";
import { CoreValidationError } from "@/lib/errors";
import { resolveTaskExecutionConfigGit } from "@/tasks/task-execution-config/domain/task-execution-config-git";
import { concurrentTest } from "tests/utils";

describe("task execution config git", () => {
  const defaultGit = {
    mode: "readWrite",
    message: null,
    onPushFailure: "fail",
    gitCredentials: "auto",
    baseBranch: null,
    workBranch: { kind: "create" },
  } as const;

  concurrentTest.each([undefined, null])(
    "resolves omitted git %p to readWrite",
    (input) => {
      expect(resolveTaskExecutionConfigGit(input)).toEqual(defaultGit);
    },
  );

  concurrentTest(
    "fills message, credentials and onPushFailure on bare readWrite",
    () => {
      expect(resolveTaskExecutionConfigGit({ mode: "readWrite" })).toEqual(
        defaultGit,
      );
    },
  );

  concurrentTest("keeps custom message, credentials and onPushFailure", () => {
    const git = {
      mode: "readWrite",
      message: "fix: {{result.summary}}",
      onPushFailure: "warn",
      gitCredentials: "none",
      baseBranch: "release/{{input.version}}",
      workBranch: { kind: "base" },
    } as const;
    expect(resolveTaskExecutionConfigGit(git)).toEqual(git);
    expect(
      resolveTaskExecutionConfigGit(resolveTaskExecutionConfigGit(git)),
    ).toEqual(git);
  });

  concurrentTest(
    "accepts readOnly with default or explicit credentials",
    () => {
      expect(resolveTaskExecutionConfigGit({ mode: "readOnly" })).toEqual({
        mode: "readOnly",
        gitCredentials: "auto",
        baseBranch: null,
      });
      expect(
        resolveTaskExecutionConfigGit({
          mode: "readOnly",
          gitCredentials: "none",
        }),
      ).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
    },
  );

  concurrentTest(
    "current input schema rejects removed none rather than normalizing it",
    () => {
      expect(repoConfigInputSchema.safeParse({ mode: "none" }).success).toBe(
        false,
      );
    },
  );

  concurrentTest.each([
    [
      { mode: "readOnly", message: "fix" },
      "TASK_EXECUTION_CONFIG_GIT_MESSAGE_NOT_ALLOWED",
    ],
    [
      { mode: "readOnly", onPushFailure: "warn" },
      "TASK_EXECUTION_CONFIG_GIT_ON_PUSH_FAILURE_NOT_ALLOWED",
    ],
  ] as const)("rejects readOnly commit options %p", (input, code) => {
    const resolve = () => resolveTaskExecutionConfigGit(input);
    expect(resolve).toThrow(CoreValidationError);
    expect(resolve).toThrow(expect.objectContaining({ code }));
  });

  concurrentTest("onPushFailure is set exactly for readWrite", () => {
    expect(resolveTaskExecutionConfigGit(undefined)).toHaveProperty(
      "onPushFailure",
      "fail",
    );
    expect(
      resolveTaskExecutionConfigGit({ mode: "readOnly" }),
    ).not.toHaveProperty("onPushFailure");
    expect(
      resolveTaskExecutionConfigGit({
        mode: "readOnly",
        gitCredentials: "none",
      }),
    ).not.toHaveProperty("onPushFailure");
  });

  concurrentTest("shared repo resolver fills only omitted fields", () => {
    const branchDefaults = {
      baseBranch: null,
    } as const;
    const defaultRepo = {
      ...defaultGit,
      ...branchDefaults,
      workBranch: { kind: "create" },
    } as const;
    expect(resolveRepoConfig()).toEqual(defaultRepo);
    expect(resolveRepoConfig({ mode: "readOnly" })).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      ...branchDefaults,
    });
    expect(resolveRepoConfig({ mode: "readWrite", message: "fix" })).toEqual({
      ...defaultRepo,
      message: "fix",
    });
    expect(
      resolveRepoConfig({ mode: "readWrite", onPushFailure: "warn" }),
    ).toEqual({
      ...defaultRepo,
      onPushFailure: "warn",
    });
  });
});
