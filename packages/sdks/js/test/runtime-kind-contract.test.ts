import { inlineEnvironment } from "./inline-environment";
import { describe, expect, test } from "bun:test";
import { Repo, Runtime, codeStep, defineStep } from "../src";
import {
  compileEnvironment,
  type RuntimeSpec,
} from "../src/definitions/steps/runtime";
import type { StepDefinitionSpec } from "../src/definitions/steps/define-step";
import { compileRepo, type RepoSpec } from "../src/definitions/steps/repo";
import { checkRuntime } from "../src/definitions/validation/validate-runtime";
import { repoConfigInputSchema, resolveRepoConfig } from "../src/repo-config";

describe("runtime-kind contract", () => {
  test("repo default and explicit pathless devcontainer stay distinct", () => {
    expect(compileEnvironment(undefined)).toBeNull();
    expect(compileEnvironment({})?.runtime).toBeUndefined();
    expect(
      compileEnvironment({ runtime: Runtime.devcontainer() }),
    ).toMatchObject({
      kind: "inline",
      runtime: { kind: "devcontainer" },
    });
  });

  test.each([
    Runtime.host(),
    Runtime.devcontainer({ config: "ci/devcontainer.json" }),
    Runtime.managed.node24(),
  ] as const)("compiles %j without legacy execution fields", (runtime) => {
    const compiled = compileEnvironment({ runtime });
    expect(compiled).toMatchObject({
      kind: "inline",
      runtime,
    });
    for (const field of [
      "executionMode",
      "runtimeKind",
      "devcontainerConfigPath",
      "managedRuntime",
    ]) {
      expect(compiled).not.toHaveProperty(field);
    }
  });

  test("codeStep still defaults to managed bun1", () => {
    const step = codeStep({ key: "code", name: "Code", fn: () => ({}) });
    expect(inlineEnvironment(step.environment)?.runtime).toEqual({
      kind: "managed",
      id: "bun1",
    });
    expect(checkRuntime([step])).toEqual([]);
  });

  test.each([Runtime.host(), Runtime.devcontainer(), Runtime.managed.bun1()])(
    "all runtime kinds support both repo modes",
    (runtime) => {
      for (const repo of [Repo.readOnly(), Repo.readWrite()]) {
        const step = defineStep({
          key: "step",
          name: "Step",
          agentPrompt: "go",
          environment: { runtime },
          repo,
        });
        expect(step.repo?.mode).toBe(repo.mode);
        expect(checkRuntime([step])).toEqual([]);
      }
      expect(resolveRepoConfig()).toEqual({
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        baseBranch: null,
        workBranch: { kind: "create" },
      });
    },
  );

  test("removed repo mode none is rejected rather than normalized", () => {
    expect(Object.keys(Repo)).not.toContain("none");
    expect(repoConfigInputSchema.safeParse({ mode: "none" }).success).toBe(
      false,
    );
    expect(() =>
      compileRepo({ mode: "none" } as unknown as RepoSpec),
    ).toThrow();
    expect(compileRepo(Repo.readOnly({ gitCredentials: "none" }))).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
    });
  });

  test("managed details require the managed kind, and vice versa", () => {
    const step: StepDefinitionSpec = defineStep({
      key: "step",
      name: "Step",
      agentPrompt: "go",
    });
    expect(
      checkRuntime([
        {
          ...step,
          environment: {
            kind: "inline",
            envJson: null,
            runtime: { kind: "managed" } as RuntimeSpec,
          },
        },
      ]),
    ).toHaveLength(1);
    expect(
      checkRuntime([
        {
          ...step,
          environment: {
            kind: "inline",
            envJson: null,
            runtime: { id: "bun1" } as unknown as RuntimeSpec,
          },
        },
      ]),
    ).toHaveLength(1);
    expect(
      checkRuntime([
        {
          ...step,
          environment: {
            kind: "inline",
            envJson: null,
            runtime: {
              kind: "host",
              config: "ci/devcontainer.json",
            } as RuntimeSpec,
          },
        },
      ]),
    ).toHaveLength(1);
  });

  test.each([null, "host", "devcontainer", "managed"] as const)(
    "validates every detail combination for runtime kind %p",
    (runtimeKind) => {
      const step: StepDefinitionSpec = defineStep({
        key: "matrix",
        name: "Matrix",
        agentPrompt: "go",
      });
      for (const managedRuntime of [null, "bun1"] as const) {
        for (const devcontainerConfigPath of [null, "ci/devcontainer.json"]) {
          const valid =
            (runtimeKind === "managed"
              ? managedRuntime !== null
              : managedRuntime === null) &&
            (runtimeKind === "devcontainer" || devcontainerConfigPath === null);
          const runtime = {
            ...(runtimeKind === null ? {} : { kind: runtimeKind }),
            ...(managedRuntime === null ? {} : { id: managedRuntime }),
            ...(devcontainerConfigPath === null
              ? {}
              : { config: devcontainerConfigPath }),
          };
          expect(
            checkRuntime([
              {
                ...step,
                environment: {
                  kind: "inline",
                  envJson: null,
                  ...(Object.keys(runtime).length === 0
                    ? {}
                    : { runtime: runtime as RuntimeSpec }),
                },
              },
            ]).length === 0,
          ).toBe(valid);
        }
      }
    },
  );
});
