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
    executionMode: "workspace",
    devcontainerConfigPath: null,
    repo: resolveRepoConfig(overrides.executionMode ?? "workspace"),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    envJson: null,
    ...overrides,
  };
}

describe("generateStepsFileContent environment", () => {
  test("emits Runtime.host() and imports Runtime for a no_workspace step", () => {
    const content = generateStepsFileContent([
      makeStep({ executionMode: "no_workspace" }),
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
        devcontainerConfigPath: ".devcontainer/frontend/devcontainer.json",
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
    const content = generateStepsFileContent([
      makeStep({ executionMode: "workspace", devcontainerConfigPath: null }),
    ]);

    expect(content).not.toContain("environment:");
    expect(content).not.toContain("executionMode");
    expect(content).not.toContain("Runtime");
  });

  test("groups runtime and vars in one environment object and imports Runtime and Env", () => {
    const content = generateStepsFileContent([
      makeStep({
        devcontainerConfigPath: ".devcontainer/perf/devcontainer.json",
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
      makeStep({ key: "summarize", executionMode: "no_workspace" }),
    ]);

    expect(content).toContain(
      'import { defineStep, Runtime } from "@scarn/sdk/definitions/steps";',
    );
    expect(content.match(/Runtime\.host\(\)/g)).toHaveLength(1);
  });

  test("a generated steps file round-trips executionMode and devcontainerConfigPath", async () => {
    const cases: Array<{
      key: string;
      executionMode: StepDefContract["executionMode"];
      devcontainerConfigPath: string | null;
    }> = [
      {
        key: "default-step",
        executionMode: "workspace",
        devcontainerConfigPath: null,
      },
      {
        key: "alt-config-step",
        executionMode: "workspace",
        devcontainerConfigPath: ".devcontainer/alt/devcontainer.json",
      },
      {
        key: "root-config-step",
        executionMode: "workspace",
        devcontainerConfigPath: ".devcontainer.json",
      },
      {
        key: "host-step",
        executionMode: "no_workspace",
        devcontainerConfigPath: null,
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
        { executionMode: string; devcontainerConfigPath: string | null }
      >;

      expect(loaded["defaultStep"]).toMatchObject(cases[0] ?? {});
      expect(loaded["altConfigStep"]).toMatchObject(cases[1] ?? {});
      expect(loaded["rootConfigStep"]).toMatchObject(cases[2] ?? {});
      expect(loaded["hostStep"]).toMatchObject(cases[3] ?? {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("omits repo and the Repo import when it is the runtime default", () => {
    const content = generateStepsFileContent([
      makeStep({ key: "workspace-default" }),
      makeStep({
        key: "host-default",
        executionMode: "no_workspace",
        repo: { mode: "none" },
      }),
      makeStep({
        key: "explicit-default",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "auto",
        },
      }),
    ]);

    expect(content).not.toContain("repo:");
    expect(content).not.toContain("Repo");
  });

  test("emits Repo.readOnly() inside a minimal environment", () => {
    const content = generateStepsFileContent([
      makeStep({ repo: { mode: "readOnly", gitCredentials: "auto" } }),
    ]);

    expect(content).toContain(
      "  environment: {\n    repo: Repo.readOnly(),\n  },",
    );
    expect(content).toContain(
      'import { defineStep, Repo } from "@scarn/sdk/definitions/steps";',
    );
    expect(content).not.toContain("Runtime");
  });

  test("emits the static form for a message without tokens", () => {
    const content = generateStepsFileContent([
      makeStep({
        repo: {
          mode: "readWrite",
          message: 'fix: "quoted"',
          onPushFailure: "fail",
          gitCredentials: "auto",
        },
      }),
    ]);

    expect(content).toContain(
      '    repo: Repo.readWrite({ message: "fix: \\"quoted\\"" }),',
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
        },
      }),
    ]);

    expect(content).toContain(
      '    repo: Repo.readWrite({ onPushFailure: "warn" }),',
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
        },
      }),
      makeStep({
        key: "both",
        repo: {
          mode: "readWrite",
          message: "{{result.summary}} for {{input.ticket-id}}",
          onPushFailure: "warn",
          gitCredentials: "auto",
        },
      }),
    ]);

    expect(content).toContain(
      "    repo: ({ result }) => Repo.readWrite({ message: `fix: ${result.summary}` }),",
    );
    expect(content).toContain(
      '    repo: ({ input, result }) => Repo.readWrite({ message: `${result.summary} for ${input["ticket-id"]}`, onPushFailure: "warn" }),',
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
        },
      }),
    ]);

    expect(content).toContain("message: `\\`a\\` \\${b} \\\\ ${input.title}`");
  });

  test("places repo beside runtime and vars in one environment object", () => {
    const content = generateStepsFileContent([
      makeStep({
        devcontainerConfigPath: ".devcontainer/perf/devcontainer.json",
        repo: { mode: "readOnly", gitCredentials: "auto" },
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
      }),
    ]);

    expect(content).toContain(
      [
        "  environment: {",
        '    runtime: Runtime.devcontainer({ config: ".devcontainer/perf/devcontainer.json" }),',
        "    vars: () => ({",
        "      PROFILER_TOKEN: Env.inherit({ secret: true }),",
        "    }),",
        "    repo: Repo.readOnly(),",
        "  },",
      ].join("\n"),
    );
    expect(content).toContain(
      'import { defineStep, Runtime, Repo, Env } from "@scarn/sdk/definitions/steps";',
    );
  });
});
