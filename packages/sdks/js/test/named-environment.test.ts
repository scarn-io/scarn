import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { codeStep, defineMcp, defineStep, Runtime, toStepSpec } from "../src";
import { compileEnvironment } from "../src/definitions/steps/runtime";
import { validateDefinitionSpecs } from "../src/definitions/validation";

describe("named environment authoring", () => {
  test("compiles exactly a named ref, including with a code runtime default", () => {
    expect(compileEnvironment("build")).toEqual({
      kind: "named",
      name: "build",
    });
    expect(
      compileEnvironment("build", { defaultRuntime: Runtime.managed.bun1() }),
    ).toEqual({
      kind: "named",
      name: "build",
    });
    const step = codeStep({
      key: "build",
      name: "Build",
      environment: "build",
      fn: () => ({}),
    });
    expect(step.environment).toEqual({ kind: "named", name: "build" });
    expect(validateDefinitionSpecs([step])).toEqual([]);
    expect(
      codeStep({ key: "default", name: "Default", fn: () => ({}) }).environment,
    ).toEqual({
      kind: "inline",
      runtime: { kind: "managed", id: "bun1" },
      envJson: null,
    });
  });

  test.each(["", "../build", "Build", "build_name", "build/name", " build"])(
    "rejects invalid name %j",
    (name) => {
      expect(() => compileEnvironment(name)).toThrow();
      expect(() =>
        defineStep({
          key: "bad",
          name: "Bad",
          environment: name,
          agentPrompt: "go",
        }),
      ).toThrow();
      expect(() =>
        codeStep({
          key: "bad",
          name: "Bad",
          environment: name,
          fn: () => ({}),
        }),
      ).toThrow();
    },
  );

  test("named prompts have exactly Record<string, string> with typed inputs", () => {
    const step = defineStep({
      key: "named",
      name: "Named",
      input: z.object({ ticket: z.string() }),
      environment: "build",
      agentPrompt: ({ env, input }) => {
        expectTypeOf(env).toEqualTypeOf<Record<string, string>>();
        expectTypeOf(input.ticket).toEqualTypeOf<string>();
        return `${input.ticket}: ${String(env.ANY_KEY)}`;
      },
    });
    expect(step.prompt).toBe("{{input.ticket}}: {{env.ANY_KEY}}");
    expect(step.environment).toEqual({ kind: "named", name: "build" });
  });

  test("omitting inline vars keeps the optional prompt fallback", () => {
    defineStep({
      key: "fallback",
      name: "Fallback",
      environment: { runtime: Runtime.host() },
      agentPrompt: ({ env }) => {
        expectTypeOf(env.ANY_KEY).toEqualTypeOf<string | undefined>();
        return String(env.ANY_KEY);
      },
    });
  });

  test("named refs retain MCP worker vars and health checks without inline hybrids", () => {
    const step = defineStep({
      key: "mcp",
      name: "MCP",
      environment: "build",
      agentPrompt: "go",
      mcps: {
        db: defineMcp({
          type: "ref",
          name: "postgres",
          env: ["DATABASE_URL"],
          optionalEnv: ["PGOPTIONS"],
          healthChecks: { query: { tool: "query", args: { sql: "select 1" } } },
        }),
      },
    });
    expect(step.environment).toEqual({ kind: "named", name: "build" });
    expect(step.opencodeMcpJson?.db).toMatchObject({
      type: "ref",
      name: "postgres",
      workerVars: [
        {
          name: "DATABASE_URL",
          source: "inherit",
          from: "DATABASE_URL",
          secret: true,
          optional: false,
          mcp: "db",
        },
        {
          name: "PGOPTIONS",
          source: "inherit",
          from: "PGOPTIONS",
          secret: true,
          optional: true,
          mcp: "db",
        },
      ],
    });
    expect(step.healthChecksJson).toHaveLength(1);
    expect(validateDefinitionSpecs([step])).toEqual([]);
  });

  test("offline validation checks named names without resolving their runtime", () => {
    const step = codeStep({
      key: "code",
      name: "Code",
      environment: "unknown-locally",
      fn: () => ({}),
    });
    expect(validateDefinitionSpecs([step])).toEqual([]);
    const issues = validateDefinitionSpecs([
      { ...toStepSpec(step), environment: { kind: "named", name: "../bad" } },
    ]);
    expect(issues.map(({ check, severity }) => ({ check, severity }))).toEqual([
      { check: "runtime", severity: "error" },
    ]);
  });
});
