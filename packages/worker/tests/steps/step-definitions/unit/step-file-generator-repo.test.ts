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
    environment: null,
    repo: resolveRepoConfig(),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    ...overrides,
  };
}

describe("generateStepsFileContent repo", () => {
  test("emits gitCredentials only when it is not the default", () => {
    const content = generateStepsFileContent([
      makeStep({
        key: "read-only",
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
      }),
      makeStep({
        key: "read-write",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "none",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
      }),
    ]);

    expect(content).toContain(
      '  repo: Repo.readOnly({ gitCredentials: "none" }),',
    );
    expect(content).toContain(
      '  repo: Repo.readWrite({ gitCredentials: "none" }),',
    );
  });

  test("emits baseBranch and workBranch only when not the default", () => {
    const content = generateStepsFileContent([
      makeStep({
        key: "read-only",
        repo: {
          mode: "readOnly",
          gitCredentials: "auto",
          baseBranch: "main",
        },
      }),
      makeStep({
        key: "read-write",
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: "ephemeral-{{env.TICKET_NUMBER}}",
          workBranch: { kind: "base" },
        },
      }),
    ]);

    expect(content).toContain('  repo: Repo.readOnly({ baseBranch: "main" }),');
    expect(content).toContain(
      "  repo: ({ env }) => Repo.readWrite({ baseBranch: `ephemeral-${env.TICKET_NUMBER}`, workBranch: WorkBranch.base() }),",
    );
    expect(content).toContain(
      'import { defineStep, Repo, WorkBranch } from "@scarn/sdk/definitions/steps";',
    );
  });

  test("a generated steps file round-trips repo through defineStep", async () => {
    const cases: Array<{
      key: string;
      varName: string;
      environment: StepDefContract["environment"];
      repo: RepoConfig;
      authored: RepoConfigInput | undefined;
    }> = [
      {
        key: "read-only",
        varName: "readOnly",
        environment: null,
        repo: {
          mode: "readOnly",
          gitCredentials: "auto",
          baseBranch: null,
        },
        authored: { mode: "readOnly" },
      },
      {
        key: "read-write-default",
        varName: "readWriteDefault",
        environment: null,
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        authored: undefined,
      },
      {
        key: "static-message",
        varName: "staticMessage",
        environment: null,
        repo: {
          mode: "readWrite",
          message: "chore: tidy",
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        authored: { mode: "readWrite", message: "chore: tidy" },
      },
      {
        key: "result-token",
        varName: "resultToken",
        environment: null,
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        authored: { mode: "readWrite", message: "fix: {{result.summary}}" },
      },
      {
        key: "input-and-result-tokens",
        varName: "inputAndResultTokens",
        environment: null,
        repo: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        authored: {
          mode: "readWrite",
          message: "{{input.ticket}}: {{result.summary}}",
        },
      },
      {
        key: "warn-only",
        varName: "warnOnly",
        environment: null,
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "warn",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        authored: { mode: "readWrite", onPushFailure: "warn" },
      },
      {
        key: "message-and-warn",
        varName: "messageAndWarn",
        environment: null,
        repo: {
          mode: "readWrite",
          message: "wip: {{result.summary}}",
          onPushFailure: "warn",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
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
        environment: null,
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
        authored: { mode: "readOnly", gitCredentials: "none" },
      },
      {
        key: "read-write-credentials",
        varName: "readWriteCredentials",
        environment: null,
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "warn",
          gitCredentials: "none",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        authored: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "warn",
          gitCredentials: "none",
        },
      },
      {
        key: "host-read-only",
        varName: "hostReadOnly",
        environment: { kind: "inline", runtime: { kind: "host" } },
        repo: {
          mode: "readOnly",
          gitCredentials: "none",
          baseBranch: null,
        },
        authored: { mode: "readOnly", gitCredentials: "none" },
      },
      {
        key: "read-only-base",
        varName: "readOnlyBase",
        environment: null,
        repo: {
          mode: "readOnly",
          gitCredentials: "auto",
          baseBranch: "release/{{input.version}}",
        },
        authored: {
          mode: "readOnly",
          baseBranch: "release/{{input.version}}",
        },
      },
      {
        key: "commit-onto-base",
        varName: "commitOntoBase",
        environment: {
          kind: "inline",
          envJson: [
            {
              name: "TICKET_NUMBER",
              source: "inherit",
              from: "TICKET_NUMBER",
              secret: false,
              optional: false,
              applies: "agent",
            },
          ],
        },
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch:
            "ephemeral-{{env.TICKET_NUMBER}}-{{workItem.platformKey}}",
          workBranch: { kind: "base" },
        },
        authored: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          baseBranch:
            "ephemeral-{{env.TICKET_NUMBER}}-{{workItem.platformKey}}",
          workBranch: { kind: "base" },
        },
      },
    ];
    const content = generateStepsFileContent(
      cases.map(({ key, environment, repo }) =>
        makeStep({ key, environment, repo }),
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
          repo: resolveRepoConfig(spec?.repo),
        }).toEqual({ key: entry.key, repo: entry.repo });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
