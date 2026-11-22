import { describe, expect } from "bun:test";
import {
  convertTaskExecutionConfigV3ToV4,
  CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION,
  readStoredTaskExecutionConfig,
  storedTaskExecutionConfigV3Schema,
  storedTaskExecutionConfigV4Schema,
  taskExecutionConfigConverters,
  type TaskExecutionConfigContentV3,
} from "@/tasks/task-execution-config/contracts/task-execution-config-stored";
import { concurrentTest } from "tests/utils";
import v3BranchFixture from "../fixtures/v3-branch.json";
import v3Fixture from "../fixtures/v3.json";
import v4Fixture from "../fixtures/v4.json";

const emptyV3: TaskExecutionConfigContentV3 = {
  environment: null,
  git: null,
  mcp: null,
  healthChecks: null,
};

const readOnlyDefaults = { baseBranch: null } as const;
const readWriteDefaults = {
  ...readOnlyDefaults,
  workBranch: { kind: "create" },
} as const;

const v3Of = (fixture: typeof v3BranchFixture) =>
  storedTaskExecutionConfigV3Schema.parse({
    environment: fixture.environmentJson,
    git: fixture.gitJson,
    mcp: fixture.mcpJson,
    healthChecks: fixture.healthChecksJson,
  });

describe("task execution config stored v4", () => {
  concurrentTest("converts the v3 fixture into the v4 fixture", () => {
    const converted = convertTaskExecutionConfigV3ToV4(
      v3Of(v3Fixture as typeof v3BranchFixture),
    );
    expect<object>(converted).toEqual({
      environment: v4Fixture.environmentJson,
      git: v4Fixture.gitJson,
      mcp: v4Fixture.mcpJson,
      healthChecks: v4Fixture.healthChecksJson,
    });
    expect(storedTaskExecutionConfigV4Schema.parse(converted)).toEqual(
      converted,
    );
  });

  concurrentTest(
    "moves an inline branch to the repo's baseBranch and fills defaults",
    () => {
      const converted = convertTaskExecutionConfigV3ToV4(v3Of(v3BranchFixture));
      expect<object>(converted).toEqual({
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
        git: {
          ...v3BranchFixture.gitJson,
          ...readWriteDefaults,
          baseBranch: "develop",
        },
        mcp: null,
        healthChecks: null,
      });
      expect(readStoredTaskExecutionConfig(3, v3BranchFixture)).toEqual({
        success: true,
        content: converted,
      });
    },
  );

  concurrentTest("moves the branch onto a readOnly repo", () => {
    const converted = convertTaskExecutionConfigV3ToV4({
      ...emptyV3,
      environment: { kind: "inline", branch: "release/{{input.version}}" },
      git: { mode: "readOnly", gitCredentials: "none" },
    });
    expect(converted.environment).toEqual({ kind: "inline" });
    expect(converted.git).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
      baseBranch: "release/{{input.version}}",
    });
  });

  concurrentTest(
    "turns a default repo with an inline branch into the explicit default",
    () => {
      const converted = convertTaskExecutionConfigV3ToV4({
        ...emptyV3,
        environment: { kind: "inline", branch: "develop" },
      });
      expect(converted.git).toEqual({
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        ...readWriteDefaults,
        baseBranch: "develop",
      });
    },
  );

  concurrentTest("drops a branch that is not a valid base branch", () => {
    for (const branch of ["", "bad branch", "{{result.x}}", "a..b"]) {
      const converted = convertTaskExecutionConfigV3ToV4({
        ...emptyV3,
        environment: { kind: "inline", branch },
      });
      expect(converted.environment).toEqual({ kind: "inline" });
      expect(converted.git).toBeNull();
    }
  });

  concurrentTest("keeps null git and named environments unchanged", () => {
    expect<object>(convertTaskExecutionConfigV3ToV4(emptyV3)).toEqual(emptyV3);
    const named = { kind: "named", name: "integration" } as const;
    expect<object>(
      convertTaskExecutionConfigV3ToV4({ ...emptyV3, environment: named }),
    ).toEqual({ ...emptyV3, environment: named });
  });

  concurrentTest("v4 inline environments strip a stray branch", () => {
    expect(
      storedTaskExecutionConfigV4Schema.parse({
        ...emptyV3,
        environment: { kind: "inline", branch: "develop" },
      }).environment,
    ).toEqual({ kind: "inline" });
  });

  concurrentTest(
    "activates v4 in the current reader and converter registry",
    () => {
      expect(CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION).toBe(4);
      expect(Object.keys(taskExecutionConfigConverters)).toEqual([
        "1",
        "2",
        "3",
      ]);
      expect<object>(readStoredTaskExecutionConfig(4, v4Fixture)).toEqual({
        success: true,
        content: {
          environment: v4Fixture.environmentJson,
          git: v4Fixture.gitJson,
          mcp: v4Fixture.mcpJson,
          healthChecks: v4Fixture.healthChecksJson,
        },
      });
    },
  );
});
