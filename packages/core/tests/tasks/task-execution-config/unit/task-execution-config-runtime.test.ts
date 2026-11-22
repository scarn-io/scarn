import { describe, expect } from "bun:test";
import {
  environmentRefSchema,
  type EnvironmentRef,
} from "@/common/contracts/environment";
import {
  environmentRefFromStored,
  storedEnvironmentFromRef,
} from "@/tasks/task-execution-config/domain/task-execution-config-runtime";
import { concurrentTest } from "tests/utils";

describe("task execution config environment mapping", () => {
  const refs: EnvironmentRef[] = [
    null,
    { kind: "inline" },
    { kind: "inline", runtime: { kind: "devcontainer" } },
    { kind: "inline", runtime: { kind: "host" } },
    { kind: "inline", runtime: { kind: "managed", id: "bun1" } },
    {
      kind: "inline",
      runtime: {
        kind: "devcontainer",
        config: ".devcontainer/alt/devcontainer.json",
      },
    },
    { kind: "named", name: "integration" },
  ];
  for (const ref of refs) {
    concurrentTest(`maps ${JSON.stringify(ref)} both ways`, () => {
      expect(environmentRefFromStored(storedEnvironmentFromRef(ref))).toEqual(
        ref,
      );
    });
  }

  concurrentTest("rejects a devcontainer path on the host", () => {
    expect(
      environmentRefSchema.safeParse({
        kind: "inline",
        runtime: { kind: "host", config: ".devcontainer/devcontainer.json" },
      }).success,
    ).toBe(false);
  });

  concurrentTest("rejects a managed identifier on the host", () => {
    expect(
      environmentRefSchema.safeParse({
        kind: "inline",
        runtime: { kind: "host", id: "bun1" },
      }).success,
    ).toBe(false);
  });

  concurrentTest("managed kind requires an identifier", () => {
    expect(
      environmentRefSchema.safeParse({
        kind: "inline",
        runtime: { kind: "managed" },
      }).success,
    ).toBe(false);
  });

  concurrentTest("rejects an inline branch on write", () => {
    const parsed = environmentRefSchema.safeParse({
      kind: "inline",
      branch: "release",
    });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "environments have no branch; use the step's repo baseBranch",
    ]);
  });

  concurrentTest("does not infer runtime from detail fields", () => {
    for (const runtime of [
      { id: "bun1" },
      { config: ".devcontainer/devcontainer.json" },
    ]) {
      expect(
        environmentRefSchema.safeParse({ kind: "inline", runtime }).success,
      ).toBe(false);
    }
  });

  concurrentTest("rejects a managed runtime with a devcontainer path", () => {
    expect(
      environmentRefSchema.safeParse({
        kind: "inline",
        runtime: {
          kind: "managed",
          id: "bun1",
          config: ".devcontainer/devcontainer.json",
        },
      }).success,
    ).toBe(false);
  });

  concurrentTest(
    "maps envJson to vars centrally without losing optional runtime",
    () => {
      const ref: EnvironmentRef = {
        kind: "inline",
        envJson: [
          {
            name: "MODE",
            source: "value",
            value: "test",
            secret: false,
            applies: "agent",
          },
        ],
      };
      expect<object | null>(storedEnvironmentFromRef(ref)).toEqual({
        kind: "inline",
        vars: ref.envJson,
      });
      expect(environmentRefFromStored(storedEnvironmentFromRef(ref))).toEqual(
        ref,
      );
    },
  );
});
