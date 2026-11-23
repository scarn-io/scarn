import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  Env,
  Runtime,
  defineEnvironment,
} from "../src/definitions/environments";
import {
  McpUnavailableError,
  codeStep,
  createFakeMcpClients,
  failStep,
  defineMcp,
  toStepSpec,
  type McpClients,
  type StepDefinitionSpec,
} from "../src/definitions/steps";
import type { McpToolContentResult } from "../src/pipelines/types";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { notion } from "./mcp-tool-step-fixtures";

const postgres = defineMcp({
  type: "ref",
  name: "postgres",
  env: ["DATABASE_URL"],
  healthChecks: {
    query: { tool: "query", args: { sql: "select 1" } },
    slow: { tool: "slow", enabled: false },
  },
});

describe("codeStep — mcps typing", () => {
  test("context.mcp has a typed method per catalog tool plus call", () => {
    codeStep({
      key: "typed",
      name: "Typed",
      mcps: { docs: notion, db: postgres },
      fn: (_input, context) => {
        expectTypeOf(context.mcp).toEqualTypeOf<
          McpClients<{ docs: typeof notion; db: typeof postgres }>
        >();
        expectTypeOf(context.mcp.docs.search).parameter(0).toEqualTypeOf<{
          query: string;
          limit?: number | undefined;
        }>();
        expectTypeOf(context.mcp.docs.search).returns.resolves.toEqualTypeOf<{
          results: { title: string }[];
        }>();
        expectTypeOf(
          context.mcp.docs.createPages,
        ).returns.resolves.toEqualTypeOf<McpToolContentResult>();
        expectTypeOf(context.mcp.db.call).parameter(0).toEqualTypeOf<string>();
        expectTypeOf(context.artifactsDir).toEqualTypeOf<string>();
        // @ts-expect-error postgres has no catalog, so no typed methods
        void context.mcp.db.query;
        // @ts-expect-error "missing" isn't one of the step's servers
        void context.mcp.missing;
        // @ts-expect-error search requires `query`
        void context.mcp.docs.search({ limit: 1 });
        return {};
      },
    });
  });

  test("a step without mcps has no context.mcp", () => {
    codeStep({
      key: "plain",
      name: "Plain",
      fn: (_input, context) => {
        expectTypeOf(context.artifactsDir).toEqualTypeOf<string>();
        // @ts-expect-error no mcps, so no mcp
        void context.mcp;
        return {};
      },
    });
  });
});

describe("codeStep — mcps compile", () => {
  test("servers and their enabled health checks compile under the step's keys", () => {
    const spec = codeStep({
      key: "sync",
      name: "Sync",
      mcps: { docs: notion, db: postgres },
      fn: () => ({}),
    });

    expect(spec.opencodeMcpJson).toEqual({
      docs: { type: "ref", name: "notion", auth: { connection: "notion" } },
      db: {
        type: "ref",
        name: "postgres",
        workerVars: [
          {
            source: "inherit",
            name: "DATABASE_URL",
            from: "DATABASE_URL",
            secret: true,
            optional: false,
            mcp: "db",
            applies: "agent",
          },
        ],
      },
    });
    expect(spec.healthChecksJson).toEqual([
      {
        kind: "tool",
        mcp: "db",
        name: "db.query",
        tool: "query",
        args: { sql: "select 1" },
        serialGroup: "db",
        severity: "required",
      },
    ]);
    expect(spec.environment).toEqual({
      kind: "inline",
      runtime: { kind: "managed", id: "bun1" },
      envJson: null,
    });
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });

  test("a step without mcps compiles no servers and keeps fn as its entrypoint", () => {
    const fn = () => ({});
    const spec = codeStep({ key: "plain", name: "Plain", fn });
    expect(spec.opencodeMcpJson).toBeNull();
    expect(spec.healthChecksJson).toBeNull();
    expect(spec.entrypoint?.fn).toBe(fn);
  });

  test("empty mcps compile like no mcps", () => {
    const spec = codeStep({
      key: "plain",
      name: "Plain",
      mcps: {},
      fn: () => 1,
    });
    expect(spec.opencodeMcpJson).toBeNull();
    expect(spec.healthChecksJson).toBeNull();
  });

  test("the entrypoint adds mcp to the worker's context and keeps the rest", async () => {
    let seen: { artifactsDir: string; hasMcp: boolean } | undefined;
    const spec = codeStep({
      key: "ctx",
      name: "Ctx",
      mcps: { docs: notion },
      fn: (_input, context) => {
        seen = {
          artifactsDir: context.artifactsDir,
          hasMcp: typeof context.mcp.docs.call === "function",
        };
        return { ok: true };
      },
    });
    const result = await spec.entrypoint?.fn(
      {},
      { artifactsDir: "/a", fail: failStep },
    );
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual({ artifactsDir: "/a", hasMcp: true });
  });

  test("outside a run, a call through the entrypoint throws McpUnavailableError", async () => {
    const spec = codeStep({
      key: "find-page",
      name: "Find page",
      mcps: { docs: notion },
      inputSchema: z.object({ title: z.string() }),
      fn: async (input, { mcp }) => {
        const found = await mcp.docs.search({ query: input.title });
        return { count: found.results.length };
      },
    });
    const saved = {
      url: process.env["SCARN_MCP_BRIDGE_URL"],
      token: process.env["SCARN_MCP_BRIDGE_TOKEN"],
    };
    delete process.env["SCARN_MCP_BRIDGE_URL"];
    delete process.env["SCARN_MCP_BRIDGE_TOKEN"];
    try {
      let failure: unknown;
      try {
        await spec.entrypoint?.fn(
          { title: "x" },
          { artifactsDir: "/a", fail: failStep },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(McpUnavailableError);
    } finally {
      if (saved.url !== undefined)
        process.env["SCARN_MCP_BRIDGE_URL"] = saved.url;
      if (saved.token !== undefined)
        process.env["SCARN_MCP_BRIDGE_TOKEN"] = saved.token;
    }
  });

  test("fn stays unit-testable with fake clients passed as context.mcp", async () => {
    const mcps = { docs: notion };
    const findPage = async (
      input: { title: string },
      { mcp }: { mcp: McpClients<typeof mcps> },
    ) => {
      const found = await mcp.docs.search({ query: input.title });
      return { count: found.results.length };
    };
    codeStep({
      key: "find-page",
      name: "Find page",
      mcps,
      inputSchema: z.object({ title: z.string() }),
      fn: findPage,
    });
    const mcp = createFakeMcpClients(mcps, {
      docs: { search: () => Promise.resolve({ results: [{ title: "a" }] }) },
    });
    expect(await findPage({ title: "a" }, { mcp })).toEqual({ count: 1 });
  });

  test("a step mcps key that collides with a handle's connector throws", () => {
    const observability = defineEnvironment({
      name: "obs",
      runtime: Runtime.managed.bun1(),
      connectors: ["datadog"],
      vars: {
        DD_API_KEY: Env.secret("DD_API_KEY"),
        DD_APPLICATION_KEY: Env.inherit({ secret: true }),
      },
    });
    const datadog = defineMcp({ type: "ref", name: "datadog" });
    expect(() =>
      codeStep({
        key: "s",
        name: "S",
        environment: observability,
        mcps: { datadog },
        fn: () => ({}),
      }),
    ).toThrow(
      'Step "s" environment "obs": step mcps "datadog" collide with the environment\'s connectors',
    );
    expect(() =>
      codeStep({
        key: "s",
        name: "S",
        environment: observability,
        mcps: { dd: datadog },
        fn: () => ({}),
      }),
    ).not.toThrow();
  });

  test("a value under mcps that isn't a defineMcp handle throws", () => {
    expect(() =>
      codeStep({
        key: "s",
        name: "S",
        mcps: {
          docs: { type: "ref", name: "notion" } as unknown as typeof notion,
        },
        fn: () => ({}),
      }),
    ).toThrow('Step "s" mcps.docs: expected a handle from defineMcp().');
  });
});

describe("validateDefinitionSpecs — code steps with MCP servers", () => {
  const base = toStepSpec(
    codeStep({
      key: "sync",
      name: "Sync",
      mcps: { db: postgres },
      fn: () => ({}),
    }),
  );

  test("a cli check on a code spec is rejected", () => {
    const spec: StepDefinitionSpec = {
      ...base,
      healthChecksJson: [
        { kind: "cli", name: "node", command: ["node", "-v"] },
      ],
    };
    const issues = validateDefinitionSpecs([spec]);
    expect(issues.map(({ check, severity }) => ({ check, severity }))).toEqual([
      { check: "health-check-code-step", severity: "error" },
    ]);
    expect(issues[0]?.message).toContain(
      'Step "sync" health check #1 ("node") is a cli check',
    );
  });

  test("a plugin tool check (no mcp) on a code spec is rejected", () => {
    const spec: StepDefinitionSpec = {
      ...base,
      healthChecksJson: [{ kind: "tool", tool: "bash" }],
    };
    const issues = validateDefinitionSpecs([spec]);
    expect(issues.map((issue) => issue.check)).toEqual([
      "health-check-code-step",
    ]);
    expect(issues[0]?.message).toContain("names no MCP server");
  });

  test("a tool check naming a server the step doesn't declare is rejected", () => {
    const spec: StepDefinitionSpec = {
      ...base,
      healthChecksJson: [{ kind: "tool", mcp: "other", tool: "ping" }],
    };
    expect(validateDefinitionSpecs([spec]).map((issue) => issue.check)).toEqual(
      ["health-check-mcp-server"],
    );
  });

  test("an agent step may still carry cli and plugin tool checks", () => {
    const spec: StepDefinitionSpec = {
      ...base,
      kind: "user_defined",
      prompt: "go",
      entrypoint: undefined,
      healthChecksJson: [
        { kind: "cli", command: ["node", "-v"] },
        { kind: "tool", tool: "bash" },
      ],
    };
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });
});
