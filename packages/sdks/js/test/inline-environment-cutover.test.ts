import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Env, Repo, Runtime, codeStep, defineStep } from "../src";
import { compileEnvironment } from "../src/definitions/steps/runtime";

describe("inline environment contract", () => {
  test("distinguishes no environment from an explicit default environment", () => {
    expect(compileEnvironment(undefined)).toBeNull();
    expect(compileEnvironment({})).toEqual({ kind: "inline", envJson: null });
  });

  test("rejects a branch", () => {
    expect(() =>
      compileEnvironment(
        // @ts-expect-error environments have no branch
        { branch: "release" },
        { stepKey: "s" },
      ),
    ).toThrow(
      'Step "s": environments have no branch; use the step\'s repo baseBranch.',
    );
  });

  test("compiles record-form vars", () => {
    expect(
      compileEnvironment({
        vars: { LEVEL: "info", SERVICE_TOKEN: Env.inherit({ secret: true }) },
      }),
    ).toEqual({
      kind: "inline",
      envJson: [
        { name: "LEVEL", source: "value", value: "info", secret: false },
        {
          name: "SERVICE_TOKEN",
          source: "inherit",
          from: "SERVICE_TOKEN",
          secret: true,
          optional: false,
        },
      ],
    });
  });

  test("record-form vars infer the prompt's declared non-secret keys", () => {
    const step = defineStep({
      key: "record",
      name: "Record",
      environment: {
        vars: { LEVEL: "info", SERVICE_TOKEN: Env.inherit({ secret: true }) },
      },
      agentPrompt: ({ env }) => {
        // @ts-expect-error only declared keys belong to the prompt environment
        void env.MISSING;
        // @ts-expect-error secret keys never belong to the prompt environment
        void env.SERVICE_TOKEN;
        return `Level: ${env.LEVEL}`;
      },
    });
    expect(step.prompt).toBe("Level: {{env.LEVEL}}");
  });

  test("top-level repo templates retain typed input and result proxies", () => {
    const step = defineStep({
      key: "repo",
      name: "Repo",
      input: z.object({ ticket: z.string() }),
      result: z.object({ summary: z.string() }),
      repo: ({ input, result }) =>
        Repo.readWrite({
          message: `${input.ticket}: ${result.summary}`,
        }),
      agentPrompt: "go",
    });
    expect(step.environment).toBeNull();
    expect(step.repo).toEqual({
      mode: "readWrite",
      message: "{{input.ticket}}: {{result.summary}}",
    });
  });

  test("vars-only code environments retain managed bun1", () => {
    const step = codeStep({
      key: "code",
      name: "Code",
      fn: () => ({}),
      repo: Repo.readOnly(),
      environment: { vars: { LEVEL: "info" } },
    });
    expect(step.environment).toMatchObject({
      kind: "inline",
      runtime: Runtime.managed.bun1(),
    });
    expect(step.repo).toEqual({ mode: "readOnly" });
    for (const removed of [
      "runtimeKind",
      "devcontainerConfigPath",
      "managedRuntime",
      "envJson",
    ]) {
      expect(step).not.toHaveProperty(removed);
    }
  });

  test("host guards also apply to record-form vars", () => {
    expect(() =>
      compileEnvironment({
        runtime: Runtime.host(),
        vars: { BUILD: Env.value({ value: "yes", applies: "setup" }) },
      }),
    ).toThrow(/needs a container/);
  });
});
