import { inlineEnvironment } from "./inline-environment";
import { describe, expect, test } from "bun:test";
import { Env, defineStep } from "../src";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { resolveEnvironment } from "../src/resolve-environment";

const githubToken = {
  name: "GITHUB_TOKEN",
  source: "secret",
  secretName: "GH_BOT_TOKEN",
  applies: "agent",
} as const;

describe("environment secret vars", () => {
  test("resolveEnvironment carries secret vars through unresolved", async () => {
    const deps = { devcontainerExists: () => Promise.resolve(false) };

    expect(
      await resolveEnvironment(deps, {
        kind: "named",
        name: "frontend",
        version: 1,
        content: {
          runtime: { kind: "host" },
          vars: [
            {
              name: "GITHUB_TOKEN",
              source: "secret",
              secretName: "GH_BOT_TOKEN",
            },
          ],
        },
      }),
    ).toEqual({
      source: "named",
      name: "frontend",
      runtime: { kind: "host" },
      envVars: [githubToken],
      connectors: [],
    });
    expect(
      await resolveEnvironment(deps, {
        kind: "inline",
        runtime: { kind: "host" },
        envJson: [githubToken],
      }),
    ).toEqual({
      source: "inline",
      runtime: { kind: "host" },
      envVars: [githubToken],
      connectors: [],
    });
  });
});

describe("Env.secret", () => {
  test("takes the variable name from the key and keeps the secret name", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      environment: {
        vars: () => ({
          GITHUB_TOKEN: Env.secret("GH_BOT_TOKEN"),
          SETUP_TOKEN: Env.secret("SETUP_TOKEN", { applies: "setup" }),
        }),
      },
      agentPrompt: ({ env }) => {
        // @ts-expect-error project secrets are dropped from the prompt env
        void env.GITHUB_TOKEN;
        return "go";
      },
    });
    expect(inlineEnvironment(spec.environment)?.envJson).toEqual([
      { name: "GITHUB_TOKEN", source: "secret", secretName: "GH_BOT_TOKEN" },
      {
        name: "SETUP_TOKEN",
        source: "secret",
        secretName: "SETUP_TOKEN",
        applies: "setup",
      },
    ]);
  });

  test("definition validation rejects an invalid secret name", () => {
    const spec = defineStep({
      key: "s",
      name: "S",
      environment: { vars: () => ({ TOKEN: Env.secret("SCARN_TOKEN") }) },
      agentPrompt: "go",
    });
    const messages = validateDefinitionSpecs([spec]).map(
      (issue) => issue.message,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('("TOKEN") secretName: is reserved');
  });
});
