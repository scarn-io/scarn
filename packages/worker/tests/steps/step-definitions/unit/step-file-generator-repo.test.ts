import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  resolveRepoConfig,
  type RepoConfig,
  type RepoConfigInput,
} from "@scarn/sdk/repo-config";
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

describe("generateStepsFileContent repo", () => {
  test("emits gitCredentials only when it is not the default", () => {
    const content = generateStepsFileContent([
      makeStep({
        key: "read-only",
        repo: { mode: "readOnly", gitCredentials: "none" },
      }),
      makeStep({
        key: "read-write",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "none",
        },
      }),
    ]);

    expect(content).toContain(
      '    repo: Repo.readOnly({ gitCredentials: "none" }),',
    );
    expect(content).toContain(
      '    repo: Repo.readWrite({ gitCredentials: "none" }),',
    );
  });

  test("a generated steps file round-trips repo through defineStep", async () => {
    const cases: Array<{
      key: string;
      varName: string;
      executionMode: StepDefContract["executionMode"];
      repo: RepoConfig;
      authored: RepoConfigInput | undefined;
    }> = [
      {
        key: "read-only",
        varName: "readOnly",
        executionMode: "workspace",
        repo: { mode: "readOnly", gitCredentials: "auto" },
        authored: { mode: "readOnly" },
      },
      {
        key: "read-write-default",
        varName: "readWriteDefault",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "auto",
        },
        authored: undefined,
      },
      {
        key: "static-message",
        varName: "staticMessage",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "chore: tidy",
          onPushFailure: "fail",
          gitCredentials: "auto",
        },
        authored: { mode: "readWrite", message: "chore: tidy" },
      },
      {
        key: "result-token",
        varName: "resultToken",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
        },
        authored: { mode: "readWrite", message: "fix: {{result.summary}}" },
      },
      {
        key: "input-and-result-tokens",
        varName: "inputAndResultTokens",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
        },
        authored: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
        },
      },
      {
        key: "warn-only",
        varName: "warnOnly",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "warn",
          gitCredentials: "auto",
        },
        authored: { mode: "readWrite", onPushFailure: "warn" },
      },
      {
        key: "message-and-warn",
        varName: "messageAndWarn",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "wip: {{result.summary}}",
          onPushFailure: "warn",
          gitCredentials: "auto",
        },
        authored: {
          mode: "readWrite",
          message: "wip: {{result.summary}}",
          onPushFailure: "warn",
        },
      },
      {
        key: "read-only-credentials",
        varName: "readOnlyCredentials",
        executionMode: "workspace",
        repo: { mode: "readOnly", gitCredentials: "none" },
        authored: { mode: "readOnly", gitCredentials: "none" },
      },
      {
        key: "read-write-credentials",
        varName: "readWriteCredentials",
        executionMode: "workspace",
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "warn",
          gitCredentials: "none",
        },
        authored: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "warn",
          gitCredentials: "none",
        },
      },
      {
        key: "host-none",
        varName: "hostNone",
        executionMode: "no_workspace",
        repo: { mode: "none" },
        authored: undefined,
      },
    ];
    const content = generateStepsFileContent(
      cases.map(({ key, executionMode, repo }) =>
        makeStep({ key, executionMode, repo }),
      ),
    );

    const dir = await mkdtemp(path.join(import.meta.dir, ".roundtrip-"));
    try {
      const file = path.join(dir, "steps.ts");
      await writeFile(file, content, "utf-8");
      const loaded = (await import(file)) as Record<
        string,
        { repo?: RepoConfigInput }
      >;

      for (const entry of cases) {
        const spec = loaded[entry.varName];
        expect({ key: entry.key, repo: spec?.repo }).toEqual({
          key: entry.key,
          repo: entry.authored,
        });
        expect({
          key: entry.key,
          repo: resolveRepoConfig(entry.executionMode, spec?.repo),
        }).toEqual({ key: entry.key, repo: entry.repo });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
