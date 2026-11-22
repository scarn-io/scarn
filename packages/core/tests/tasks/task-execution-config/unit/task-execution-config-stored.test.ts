import { describe, expect } from "bun:test";
import {
  convertTaskExecutionConfigV1ToV2,
  convertTaskExecutionConfigV2ToV3,
  convertTaskExecutionConfigV3ToV4,
  readStoredTaskExecutionConfig,
  storedTaskExecutionConfigV2Schema,
  storedTaskExecutionConfigV1Schema,
  storedTaskExecutionConfigV4Schema,
  taskExecutionConfigConverters,
} from "@/tasks/task-execution-config/contracts/task-execution-config-stored";
import { resolveTaskExecutionConfigGit } from "@/tasks/task-execution-config/domain/task-execution-config-git";
import { concurrentTest } from "tests/utils";
import v1GitCredentialsFixture from "../fixtures/v1-git-credentials.json";
import v1NoneFixture from "../fixtures/v1-none.json";
import v1Fixture from "../fixtures/v1.json";
import v2Fixture from "../fixtures/v2.json";
import v3Fixture from "../fixtures/v3.json";
import v4Fixture from "../fixtures/v4.json";

const branchDefaults = {
  baseBranch: null,
  workBranch: { kind: "create" },
} as const;

const gitOf = (fixture: typeof v1Fixture) => {
  const read = readStoredTaskExecutionConfig(fixture.schemaVersion, fixture);
  if (!read.success) throw new Error(read.reason);
  return read.content.git;
};

describe("task execution config stored read", () => {
  concurrentTest("a v1 git without gitCredentials reads as auto", () => {
    expect<object | null>(gitOf(v1Fixture)).toEqual({
      ...v1Fixture.gitJson,
      gitCredentials: "auto",
      ...branchDefaults,
    });
  });

  concurrentTest(
    "a v1 readOnly git without gitCredentials reads as auto",
    () => {
      expect(
        gitOf({ ...v1Fixture, gitJson: { mode: "readOnly" } } as never),
      ).toEqual({
        mode: "readOnly",
        gitCredentials: "auto",
        baseBranch: null,
      });
    },
  );

  concurrentTest("a v1 git with gitCredentials keeps it", () => {
    expect<object | null>(gitOf(v1GitCredentialsFixture)).toEqual({
      ...v1GitCredentialsFixture.gitJson,
      ...branchDefaults,
    });
  });

  concurrentTest(
    "a v1 none git converts to non-committing git without credentials",
    () => {
      expect(
        gitOf({
          ...v1Fixture,
          runtimeJson: { type: "none" },
          gitJson: { mode: "none" },
        } as never),
      ).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
    },
  );
});

describe("task execution config stored v2", () => {
  concurrentTest(
    "materializes the implicit v1 host non-committing default",
    () => {
      const read = readStoredTaskExecutionConfig(1, {
        ...v1NoneFixture,
        gitJson: null,
      });
      if (!read.success) throw new Error(read.reason);

      expect(read.content.environment).toEqual({
        kind: "inline",
        runtime: { kind: "host" },
      });
      expect(read.content.git).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
      expect(resolveTaskExecutionConfigGit(read.content.git)).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
    },
  );

  concurrentTest(
    "keeps current v2 host null git as the readWrite default",
    () => {
      const read = readStoredTaskExecutionConfig(2, {
        ...v2Fixture,
        gitJson: null,
      });
      if (!read.success) throw new Error(read.reason);

      expect(read.content.git).toBeNull();
      expect(resolveTaskExecutionConfigGit(read.content.git)).toEqual({
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        baseBranch: null,
        workBranch: { kind: "create" },
      });
    },
  );

  concurrentTest("preserves implicit v1 workspace git defaults", () => {
    for (const runtimeJson of [
      null,
      { type: "devcontainer" },
      { type: "managed", id: "bun1" },
    ] as const) {
      const read = readStoredTaskExecutionConfig(1, {
        ...v1Fixture,
        runtimeJson,
        gitJson: null,
      });
      if (!read.success) throw new Error(read.reason);

      const expected = convertTaskExecutionConfigV2ToV3(
        storedTaskExecutionConfigV2Schema.parse({
          runtime: runtimeJson,
          env: v1Fixture.envJson,
          git: null,
          mcp: v1Fixture.mcpJson,
          healthChecks: v1Fixture.healthChecksJson,
        }),
      );
      expect(read.content.environment).toEqual(expected.environment);
      expect(read.content.git).toBeNull();
    }
  });

  concurrentTest("converts v1 none to host and non-committing git", () => {
    const read = readStoredTaskExecutionConfig(
      v1NoneFixture.schemaVersion,
      v1NoneFixture,
    );
    if (!read.success) throw new Error(read.reason);

    const converted = taskExecutionConfigConverters[1](
      storedTaskExecutionConfigV1Schema.parse({
        runtime: v1NoneFixture.runtimeJson,
        env: v1NoneFixture.envJson,
        git: v1NoneFixture.gitJson,
        mcp: v1NoneFixture.mcpJson,
        healthChecks: v1NoneFixture.healthChecksJson,
      }),
    );
    expect<object>(converted).toEqual({
      runtime: v2Fixture.runtimeJson,
      env: v2Fixture.envJson,
      git: v2Fixture.gitJson,
      mcp: v2Fixture.mcpJson,
      healthChecks: v2Fixture.healthChecksJson,
    });
    expect(storedTaskExecutionConfigV2Schema.parse(converted)).toEqual(
      converted,
    );
    expect(read.content).toEqual(
      convertTaskExecutionConfigV3ToV4(
        convertTaskExecutionConfigV2ToV3(converted),
      ),
    );
    expect(read.content.environment).toEqual({
      kind: "inline",
      runtime: { kind: "host" },
    });
    expect(read.content.git).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
      baseBranch: null,
    });
  });

  concurrentTest(
    "preserves existing settings and git credential defaults",
    () => {
      for (const fixture of [v1Fixture, v1GitCredentialsFixture]) {
        const read = readStoredTaskExecutionConfig(
          fixture.schemaVersion,
          fixture,
        );
        if (!read.success) throw new Error(read.reason);

        const converted = read.content;
        expect<object>(converted).toEqual(read.content);
        expect(storedTaskExecutionConfigV4Schema.parse(converted)).toEqual(
          converted,
        );
      }
    },
  );

  concurrentTest("preserves null overrides", () => {
    const content = {
      runtime: null,
      env: null,
      git: null,
      mcp: null,
      healthChecks: null,
    };
    expect(convertTaskExecutionConfigV1ToV2(content)).toEqual(content);
  });

  concurrentTest("preserves readOnly git and its credential policy", () => {
    for (const gitCredentials of ["auto", "none"] as const) {
      const read = readStoredTaskExecutionConfig(1, {
        ...v1Fixture,
        gitJson: { mode: "readOnly", gitCredentials },
      });
      if (!read.success) throw new Error(read.reason);

      const converted = read.content;
      expect<object>(converted).toEqual(read.content);
      expect(storedTaskExecutionConfigV4Schema.parse(converted)).toEqual(
        converted,
      );
    }
  });

  concurrentTest(
    "v2 remains structural and defaults missing credentials",
    () => {
      expect(
        storedTaskExecutionConfigV2Schema.parse({
          runtime: { type: "devcontainer", configPath: "", extra: true },
          env: null,
          git: { mode: "readOnly" },
          mcp: null,
          healthChecks: null,
          extra: true,
        }),
      ).toEqual({
        runtime: { type: "devcontainer", configPath: "" },
        env: null,
        git: { mode: "readOnly", gitCredentials: "auto" },
        mcp: null,
        healthChecks: null,
      });
    },
  );

  concurrentTest("v2 rejects the removed runtime and git discriminants", () => {
    const content = convertTaskExecutionConfigV1ToV2({
      runtime: null,
      env: null,
      git: null,
      mcp: null,
      healthChecks: null,
    });
    expect(
      storedTaskExecutionConfigV2Schema.safeParse({
        ...content,
        runtime: { type: "none" },
      }).success,
    ).toBe(false);
    expect(
      storedTaskExecutionConfigV2Schema.safeParse({
        ...content,
        git: { mode: "none" },
      }).success,
    ).toBe(false);
  });

  concurrentTest("retains the v2 reader", () => {
    expect<object>(
      readStoredTaskExecutionConfig(v2Fixture.schemaVersion, v2Fixture),
    ).toEqual({
      success: true,
      content: {
        environment: {
          kind: "inline",
          runtime: { kind: "host" },
        },
        git: v4Fixture.gitJson,
        mcp: v2Fixture.mcpJson,
        healthChecks: v2Fixture.healthChecksJson,
      },
    });
  });
});

describe("task execution config stored v3", () => {
  concurrentTest("reads the v3 fixture as the v4 fixture", () => {
    expect<object>(readStoredTaskExecutionConfig(3, v3Fixture)).toEqual({
      success: true,
      content: {
        environment: v4Fixture.environmentJson,
        git: v4Fixture.gitJson,
        mcp: v4Fixture.mcpJson,
        healthChecks: v4Fixture.healthChecksJson,
      },
    });
  });

  concurrentTest(
    "keeps null distinct from an explicit empty inline environment",
    () => {
      const empty = {
        runtime: null,
        env: null,
        git: null,
        mcp: null,
        healthChecks: null,
      };
      expect(convertTaskExecutionConfigV2ToV3(empty).environment).toBeNull();
      expect(
        convertTaskExecutionConfigV2ToV3({
          ...empty,
          runtime: { type: "devcontainer" },
        }).environment,
      ).toEqual({ kind: "inline", runtime: { kind: "devcontainer" } });
      expect(
        readStoredTaskExecutionConfig(3, {
          ...v3Fixture,
          environmentJson: { kind: "inline" },
        }),
      ).toMatchObject({
        success: true,
        content: { environment: { kind: "inline" } },
      });
    },
  );
});
