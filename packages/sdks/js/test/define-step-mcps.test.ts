import { inlineEnvironment } from "./inline-environment";
import { describe, expect, test } from "bun:test";
import { Env, Runtime, defineMcp, defineStep } from "../src";
import { validateDefinitionSpecs } from "../src/definitions/validation";

const postgres = defineMcp({
  type: "ref",
  name: "postgres",
  env: ["DATABASE_URL", "SHARED_TOKEN"],
  healthChecks: { query: { tool: "query", args: { sql: "select 1" } } },
});

const datadog = defineMcp({
  type: "ref",
  name: "datadog",
  env: ["DATADOG_API_KEY"],
  optionalEnv: ["SHARED_TOKEN", "DATADOG_SITE"],
  healthChecks: { ping: { tool: "list_monitors" } },
});

const tch = defineMcp({
  type: "ref",
  name: "tch",
  env: ["TICKET_NUMBER"],
  healthChecks: {
    creds: { tool: "fetch_operator_credentials", timeoutSeconds: 30 },
    impersonate: { tool: "impersonate", enabled: false },
  },
});

function step(overrides: Partial<Parameters<typeof defineStep>[0]> = {}) {
  return defineStep({
    key: "repro",
    name: "Repro",
    agentPrompt: "Go.",
    ...overrides,
  });
}

const inherit = (name: string, optional: boolean, mcp: string) => ({
  source: "inherit" as const,
  name,
  from: name,
  secret: true,
  optional,
  mcp,
  applies: "agent" as const,
});

describe("defineStep — mcps", () => {
  test("a host step preserves repository MCP refs and their environment", () => {
    const spec = step({
      environment: { runtime: Runtime.host() },
      mcps: { db: postgres },
    });
    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "host",
    });
    expect(spec.opencodeMcpJson).toEqual({
      db: {
        type: "ref",
        name: "postgres",
        workerVars: [
          inherit("DATABASE_URL", false, "db"),
          inherit("SHARED_TOKEN", false, "db"),
        ],
      },
    });
    expect(
      spec.opencodeMcpJson?.db?.workerVars?.find(
        (entry) => entry.name === "DATABASE_URL",
      ),
    ).toMatchObject({
      name: "DATABASE_URL",
      source: "inherit",
      mcp: "db",
    });
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });

  test("compiles servers, checks and env into the wire fields", () => {
    const spec = step({
      environment: {
        vars: () => ({
          TICKET_NUMBER: "{{input.ticket}}",
          LOG_LEVEL: Env.inherit({ optional: true }),
        }),
      },
      healthChecks: [{ kind: "cli", command: ["true"] }],
      mcps: {
        db: postgres,
        datadog: datadog.overrideCheck("ping", { severity: "warn" }),
        tch: tch.enableCheck("impersonate").overrideCheck("impersonate", {
          timeoutSeconds: 10,
        }),
      },
    });

    expect(spec.opencodeMcpJson).toEqual({
      db: {
        type: "ref",
        name: "postgres",
        workerVars: [
          inherit("DATABASE_URL", false, "db"),
          inherit("SHARED_TOKEN", false, "db"),
        ],
      },
      datadog: {
        type: "ref",
        workerVars: [
          inherit("DATADOG_API_KEY", false, "datadog"),
          inherit("SHARED_TOKEN", true, "datadog"),
          inherit("DATADOG_SITE", true, "datadog"),
        ],
      },
      tch: {
        type: "ref",
        workerVars: [inherit("TICKET_NUMBER", false, "tch")],
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
      {
        kind: "tool",
        mcp: "datadog",
        name: "datadog.ping",
        tool: "list_monitors",
        serialGroup: "datadog",
        severity: "warn",
      },
      {
        kind: "tool",
        mcp: "tch",
        name: "tch.creds",
        tool: "fetch_operator_credentials",
        timeoutSeconds: 30,
        serialGroup: "tch",
        severity: "required",
      },
      {
        kind: "tool",
        mcp: "tch",
        name: "tch.impersonate",
        tool: "impersonate",
        timeoutSeconds: 10,
        serialGroup: "tch",
        severity: "required",
      },
      { kind: "cli", command: ["true"] },
    ]);

    expect(inlineEnvironment(spec.environment)?.envJson).toEqual([
      {
        name: "TICKET_NUMBER",
        source: "value",
        value: "{{input.ticket}}",
        secret: false,
      },
      {
        name: "LOG_LEVEL",
        source: "inherit",
        from: "LOG_LEVEL",
        secret: false,
        optional: true,
      },
    ]);

    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });

  test("a var optional on both servers stays optional", () => {
    const a = defineMcp({ type: "ref", name: "a", optionalEnv: ["X"] });
    const b = defineMcp({ type: "ref", name: "b", optionalEnv: ["X"] });
    const spec = step({ mcps: { a, b } });
    expect(spec.environment).toBeNull();
    expect(spec.opencodeMcpJson?.a?.workerVars).toEqual([
      inherit("X", true, "a"),
    ]);
    expect(spec.opencodeMcpJson?.b?.workerVars).toEqual([
      inherit("X", true, "b"),
    ]);
  });

  test("the same handle under two keys yields one server per key", () => {
    const spec = step({ mcps: { first: tch, second: tch.disableAllChecks() } });
    expect(spec.opencodeMcpJson).toEqual({
      first: {
        type: "ref",
        name: "tch",
        workerVars: [inherit("TICKET_NUMBER", false, "first")],
      },
      second: {
        type: "ref",
        name: "tch",
        workerVars: [inherit("TICKET_NUMBER", false, "second")],
      },
    });
    expect(spec.healthChecksJson?.map((check) => check.name)).toEqual([
      "first.creds",
    ]);
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });

  test("empty mcps leaves the step's own fields untouched", () => {
    const spec = step({ mcps: {} });
    expect(spec.opencodeMcpJson).toBeNull();
    expect(spec.healthChecksJson).toBeNull();
    expect(spec.environment).toBeNull();
  });

  test("an MCP with every check disabled and no env adds only the server", () => {
    const quiet = defineMcp({
      type: "ref",
      name: "q",
      healthChecks: { a: { tool: "a" } },
    });
    const spec = step({ mcps: { q: quiet.disableCheck("a") } });
    expect(spec.opencodeMcpJson).toEqual({ q: { type: "ref" } });
    expect(spec.healthChecksJson).toBeNull();
    expect(spec.environment).toBeNull();
  });

  test("a host step with inline servers compiles and validates", () => {
    const playwright = defineMcp({
      type: "local",
      name: "playwright",
      command: ["npx", "-y", "@playwright/mcp@0.0.68", "--headless"],
      environment: {
        PLAYWRIGHT_BROWSERS_PATH: "{env:PLAYWRIGHT_BROWSERS_PATH}",
      },
      healthChecks: {
        navigate: { tool: "browser_navigate", args: { url: "about:blank" } },
      },
    });
    const linear = defineMcp({
      type: "remote",
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer {env:LINEAR_API_KEY}" },
    });
    const spec = step({
      environment: { runtime: Runtime.host() },
      mcps: { playwright, linear },
    });

    expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
      kind: "host",
    });
    expect(spec.opencodeMcpJson).toEqual({
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@0.0.68", "--headless"],
        environment: {
          PLAYWRIGHT_BROWSERS_PATH: "{env:PLAYWRIGHT_BROWSERS_PATH}",
        },
        workerVars: [inherit("PLAYWRIGHT_BROWSERS_PATH", false, "playwright")],
      },
      linear: {
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer {env:LINEAR_API_KEY}" },
        workerVars: [inherit("LINEAR_API_KEY", false, "linear")],
      },
    });
    expect(inlineEnvironment(spec.environment)?.envJson).toBeNull();
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });
});
