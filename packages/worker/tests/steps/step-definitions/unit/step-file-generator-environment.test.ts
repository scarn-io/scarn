import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import {
  generateStepsFileContent,
  type StepDefContract,
} from "../../../../src/steps/step-definitions/infra/step-file-generator";

function makeStep(overrides: Partial<StepDefContract> = {}): StepDefContract {
  return {
    key: "browser-repro",
    name: "Browser Repro",
    description: null,
    prompt: "Open the app.",
    version: 1,
    status: "active",
    environment: null,
    repo: resolveRepoConfig(),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    ...overrides,
  };
}

describe("generateStepsFileContent environment", () => {
  test("preserves an empty inline environment distinct from null", () => {
    const content = generateStepsFileContent([
      makeStep({ environment: { kind: "inline" } }),
    ]);
    expect(content).toContain("environment: {");
    expect(content).not.toContain("Runtime");
  });

  test("emits runtime and vars, and no branch", () => {
    const content = generateStepsFileContent([
      makeStep({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "node24" },
          envJson: [
            {
              name: "MODE",
              source: "value",
              value: "test",
              secret: false,
              applies: "agent",
            },
          ],
        },
      }),
    ]);
    expect(content).not.toContain("branch:");
    expect(content).toContain("runtime: Runtime.managed.node24(),");
    expect(content).toContain('MODE: "test",');
  });

  test("rejects named source generation until named SDK authoring is available", () => {
    expect(() =>
      generateStepsFileContent([
        makeStep({ environment: { kind: "named", name: "shared" } }),
      ]),
    ).toThrow("Named environment source generation is not supported yet");
  });
  test("emits Runtime.host() and imports Runtime for a host step", () => {
    const content = generateStepsFileContent([
      makeStep({ environment: { kind: "inline", runtime: { kind: "host" } } }),
    ]);

    expect(content).toContain(
      "environment: {\n    runtime: Runtime.host(),\n  }",
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";',
    );
    expect(content).not.toContain("executionMode");
  });

  test("emits Runtime.devcontainer with the config for a workspace step with a config path", () => {
    const content = generateStepsFileContent([
      makeStep({
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/frontend/devcontainer.json",
          },
        },
      }),
    ]);

    expect(content).toContain(
      'runtime: Runtime.devcontainer({ config: ".devcontainer/frontend/devcontainer.json" }),',
    );
    expect(content).toContain(
      'import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";',
    );
  });

  test("omits environment and the Runtime import for a default workspace step", () => {
    const content = generateStepsFileContent([makeStep({ environment: null })]);

    expect(content).not.toContain("environment:");
    expect(content).not.toContain("executionMode");
    expect(content).not.toContain("Runtime");
  });

  test("groups runtime and vars in one environment object and imports Runtime and Env", () => {
    const content = generateStepsFileContent([
      makeStep({
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/perf/devcontainer.json",
          },
          envJson: [
            {
              name: "PROFILER_TOKEN",
              source: "inherit",
              from: "PROFILER_TOKEN",
              secret: true,
              optional: false,
              applies: "agent",
            },
          ],
        },
      }),
    ]);

    expect(content).toContain(
      [
        "  environment: {",
        '    runtime: Runtime.devcontainer({ config: ".devcontainer/perf/devcontainer.json" }),',
        "    vars: () => ({",
        "      PROFILER_TOKEN: Env.inherit({ secret: true }),",
        "    }),",
        "  },",
      ].join("\n"),
    );
    expect(content).toContain(
      'import { defineStep, Runtime, Env } from "@scarn/sdk/definitions/steps";',
    );
  });

  test("imports Runtime only when some step needs it", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "plain" }),
      makeStep({
        key: "summarize",
        environment: { kind: "inline", runtime: { kind: "host" } },
      }),
    ]);

    expect(content).toContain(
      'import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";',
    );
    expect(content.match(/Runtime\.host\(\)/g)).toHaveLength(1);
  });

  test("a generated steps file round-trips environment refs", async () => {
    const cases: Array<{
      key: string;
      environment: StepDefContract["environment"];
    }> = [
      {
        key: "default-step",
        environment: null,
      },
      {
        key: "alt-config-step",
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/alt/devcontainer.json",
          },
        },
      },
      {
        key: "root-config-step",
        environment: {
          kind: "inline",
          runtime: { kind: "devcontainer", config: ".devcontainer.json" },
        },
      },
      {
        key: "host-step",
        environment: { kind: "inline", runtime: { kind: "host" } },
      },
      {
        key: "pathless-devcontainer-step",
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      },
    ];
    const content = generateStepsFileContent(
      cases.map((entry) => makeStep(entry)),
    );

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as Record<
        string,
        {
          environment: StepDefContract["environment"];
        }
      >;

      expect(loaded["defaultStep"]).toMatchObject(cases[0] ?? {});
      expect(loaded["altConfigStep"]).toMatchObject(cases[1] ?? {});
      expect(loaded["rootConfigStep"]).toMatchObject(cases[2] ?? {});
      expect(loaded["hostStep"]).toMatchObject(cases[3] ?? {});
      expect(loaded["pathlessDevcontainerStep"]).toMatchObject(cases[4] ?? {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("omits repo and the Repo import when it is the runtime default", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "workspace-default" }),
      makeStep({
        key: "host-default",
        environment: { kind: "inline", runtime: { kind: "host" } },
        repo: resolveRepoConfig(),
      }),
      makeStep({
        key: "explicit-default",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
    ]);

    expect(content).not.toContain("repo:");
    expect(content).not.toContain("Repo");
  });

  test("emits Repo.readOnly() independently of environment", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readOnly",
          gitCredentials: "auto",
          baseBranch: null,
        },
      }),
    ]);

    expect(content).toContain("  repo: Repo.readOnly(),");
    expect(content).toContain(
      'import { defineStep, Repo } from "@scarn/sdk/definitions/steps";',
    );
    expect(content).not.toContain("Runtime");
    expect(content).not.toContain("environment:");
  });

  test("emits the static form for a message without tokens", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readWrite",
          message: 'fix: "quoted"',
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
    ]);

    expect(content).toContain(
      '  repo: Repo.readWrite({ message: "fix: \\"quoted\\"" }),',
    );
  });

  test("emits onPushFailure only when it is not the default", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "warn",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
    ]);

    expect(content).toContain(
      '  repo: Repo.readWrite({ onPushFailure: "warn" }),',
    );
  });

  test("emits the function form and destructures only the proxies a message reads", () => {
    const content = generateStepsFileContent([
      makeStep({
        key: "result-only",
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
      makeStep({
        key: "both",
        repo: {
          mode: "readWrite",
          message: "{{result.summary}} for {{input.ticket-id}}",
          onPushFailure: "warn",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
    ]);

    expect(content).toContain(
      "  repo: ({ result }) => Repo.readWrite({ message: `fix: ${result.summary}` }),",
    );
    expect(content).toContain(
      '  repo: ({ input, result }) => Repo.readWrite({ message: `${result.summary} for ${input["ticket-id"]}`, onPushFailure: "warn" }),',
    );
  });

  test("escapes backticks, interpolation openers and backslashes beside tokens", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readWrite",
          message: "`a` ${b} \\ {{input.title}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
    ]);

    expect(content).toContain("message: `\\`a\\` \\${b} \\\\ ${input.title}`");
  });

  test("places repo outside the runtime and vars environment object", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readOnly",
          gitCredentials: "auto",
          baseBranch: null,
        },
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/perf/devcontainer.json",
          },
          envJson: [
            {
              name: "PROFILER_TOKEN",
              source: "inherit",
              from: "PROFILER_TOKEN",
              secret: true,
              optional: false,
              applies: "agent",
            },
          ],
        },
      }),
    ]);

    expect(content).toContain(
      [
        "  environment: {",
        '    runtime: Runtime.devcontainer({ config: ".devcontainer/perf/devcontainer.json" }),',
        "    vars: () => ({",
        "      PROFILER_TOKEN: Env.inherit({ secret: true }),",
        "    }),",
        "  },",
        "  repo: Repo.readOnly(),",
      ].join("\n"),
    );
    expect(content).toContain(
      'import { defineStep, Runtime, Repo, Env } from "@scarn/sdk/definitions/steps";',
    );
  });
});
