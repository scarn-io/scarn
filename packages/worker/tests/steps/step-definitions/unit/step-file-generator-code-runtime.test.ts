import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import { envVarsSchema } from "@scarn/sdk/env-vars";
import {
  codeStep,
  Runtime,
  toStepSpec,
  type StepDefinitionSpec,
} from "@scarn/sdk/definitions/steps";
import {
  generateStepsFileContent,
  keyToVarName,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(overrides: Partial<StepDefContract> = {}): StepDefContract {
  return {
    key: "lookup-criteria",
    name: "Lookup Criteria",
    description: null,
    prompt: "Open the app.",
    version: 1,
    status: "active",
    kind: "user_defined",
    environment: null,
    repo: resolveRepoConfig(),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    ...overrides,
  };
}

describe("generateStepsFileContent code step runtime", () => {
  test("omits runtime and the Runtime import for the default managed runtime", () => {
    const content = generateStepsFileContent([
      makeStep({
        kind: "code",
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
        prompt: null,
      }),
    ]);

    expect(content).toContain("environment:");
    expect(content).not.toContain("runtime:");
    expect(content).not.toContain("Runtime");
  });

  test("emits Runtime.managed.<id>() and imports Runtime for another managed runtime", () => {
    const content = generateStepsFileContent([
      makeStep({
        kind: "code",
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "node24" },
        },
        prompt: null,
      }),
    ]);

    expect(content).toContain(
      "environment: {\n    runtime: Runtime.managed.node24(),\n  }",
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";',
    );
  });

  test("emits an explicit Runtime.devcontainer() for a non-managed code step without a config path", () => {
    const content = generateStepsFileContent([
      makeStep({
        kind: "code",
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
        prompt: null,
      }),
    ]);

    expect(content.match(/runtime: Runtime\.devcontainer\(\),/g)).toHaveLength(
      1,
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";',
    );
  });

  test("rejects a null code environment rather than changing repository default to a devcontainer", () => {
    expect(() =>
      generateStepsFileContent([
        makeStep({
          key: "repo-default",
          kind: "code",
          prompt: null,
          environment: null,
        }),
      ]),
    ).toThrow("SDK support for explicit null environments");
  });

  test("keeps the config emission for a non-managed code step with a config path", () => {
    const content = generateStepsFileContent([
      makeStep({
        kind: "code",
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/alt/devcontainer.json",
          },
        },
        prompt: null,
      }),
    ]);

    expect(content).toContain(
      'runtime: Runtime.devcontainer({ config: ".devcontainer/alt/devcontainer.json" }),',
    );
    expect(content).not.toContain("Runtime.devcontainer(),");
  });

  test("emits Runtime.managed.bun1() for an agent step, where bun1 is not the default", () => {
    const content = generateStepsFileContent([
      makeStep({
        kind: "user_defined",
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
      }),
    ]);

    expect(content).toContain(
      "environment: {\n    runtime: Runtime.managed.bun1(),\n  }",
    );
  });

  test("leaves default agent steps unchanged whatever kind they carry", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "plain-agent", kind: "user_defined" }),
      makeStep({
        key: "null-agent",
        kind: "user_defined",
        environment: null,
      }),
      makeStep({ key: "legacy-agent", kind: undefined }),
    ]);

    expect(content).not.toContain("environment:");
    expect(content).not.toContain("Runtime");
  });

  test("pushing, pulling and pushing again keeps runtime selections", async () => {
    const noop = () => ({});
    const authored = [
      {
        key: "omitted",
        spec: codeStep({ key: "omitted", name: "Omitted", fn: noop }),
      },
      {
        key: "default-explicit",
        spec: codeStep({
          key: "default-explicit",
          name: "Default Explicit",
          environment: { runtime: Runtime.managed.bun1() },
          fn: noop,
        }),
      },
      {
        key: "node",
        spec: codeStep({
          key: "node",
          name: "Node",
          environment: { runtime: Runtime.managed.node24() },
          fn: noop,
        }),
      },
      {
        key: "project",
        spec: codeStep({
          key: "project",
          name: "Project",
          environment: { runtime: Runtime.devcontainer() },
          fn: noop,
        }),
      },
      {
        key: "project-config",
        spec: codeStep({
          key: "project-config",
          name: "Project Config",
          environment: {
            runtime: Runtime.devcontainer({
              config: ".devcontainer/alt/devcontainer.json",
            }),
          },
          fn: noop,
        }),
      },
      {
        key: "legacy",
        spec: {
          ...toStepSpec(codeStep({ key: "legacy", name: "Legacy", fn: noop })),
          environment: {
            kind: "inline" as const,
            runtime: { kind: "devcontainer" as const },
            envJson: null,
          },
        },
      },
    ];

    const pulled = generateStepsFileContent(
      authored.map(({ key, spec }) =>
        makeStep({
          key,
          kind: "code",
          prompt: null,
          environment:
            spec.environment?.kind !== "inline"
              ? spec.environment
              : {
                  ...spec.environment,
                  envJson: envVarsSchema
                    .nullable()
                    .parse(spec.environment.envJson),
                },
        }),
      ),
    ).replace('from "@scarn/sdk/definitions/steps"', 'from "./code-step-shim"');

    const shim = [
      'import { codeStep } from "@scarn/sdk/definitions/steps";',
      'export * from "@scarn/sdk/definitions/steps";',
      "export const defineStep = ({ key, name, environment }) =>",
      "  codeStep({ key, name, environment, fn: () => ({}) });",
      "",
    ].join("\n");

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      await writeFile(path.join(dir, "code-step-shim.ts"), shim, "utf-8");
      const file = path.join(dir, "steps.ts");
      await writeFile(file, pulled, "utf-8");
      const loaded = (await import(file)) as Record<
        string,
        {
          environment: StepDefinitionSpec["environment"];
        }
      >;

      for (const { key, spec } of authored) {
        const repushed = loaded[keyToVarName(key)];
        expect({
          key,
          environment: repushed?.environment,
        }).toEqual({
          key,
          environment: spec.environment,
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
