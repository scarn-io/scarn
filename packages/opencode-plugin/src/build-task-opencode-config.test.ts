import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  OpenCodeOverlayConfig as Config,
  OpenCodePermissionRule,
} from "./opencode-overlay-config";
import {
  buildScarnOverrideConfig,
  mcpToolActionPattern,
} from "./build-task-opencode-config";

const BASELINE: Config = {
  $schema: "https://opencode.ai/config.json",
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "scarn*", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
  ],
  mcp: { servers: {} },
};

/**
 * Mirrors OpenCode v2's documented permission evaluation (ordered rules, last
 * match wins, `*` spans any characters) so the emitted rules can be checked
 * for their effect, not just their literal shape. Agent rules are appended
 * after global rules.
 */
function evaluate(
  rules: readonly OpenCodePermissionRule[],
  action: string,
): OpenCodePermissionRule["effect"] {
  const matches = (pattern: string, value: string): boolean =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
        .replaceAll("*", ".*")
        .replaceAll("?", ".")}$`,
      "u",
    ).test(value);
  let effect: OpenCodePermissionRule["effect"] = "ask";
  for (const rule of rules) {
    if (matches(rule.action, action) && matches(rule.resource, "*")) {
      effect = rule.effect;
    }
  }
  return effect;
}

function effectiveRules(
  config: Config,
  agent: string,
): OpenCodePermissionRule[] {
  return [
    ...(config.permissions ?? []),
    ...(config.agents?.[agent]?.permissions ?? []),
  ];
}

describe("buildScarnOverrideConfig", () => {
  let savedModel: string | undefined;
  beforeEach(() => {
    savedModel = process.env["AGENT_DEFAULT_MODEL"];
    delete process.env["AGENT_DEFAULT_MODEL"];
  });
  afterEach(() => {
    if (savedModel === undefined) delete process.env["AGENT_DEFAULT_MODEL"];
    else process.env["AGENT_DEFAULT_MODEL"] = savedModel;
  });

  test("returns the baseline unchanged when the step adds nothing", () => {
    expect(buildScarnOverrideConfig({ baseConfig: BASELINE })).toEqual(
      BASELINE,
    );
  });

  test("passes step MCP servers through under mcp.servers with Code Mode off", () => {
    const config = buildScarnOverrideConfig({
      baseConfig: BASELINE,
      stepMcpServers: {
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp@0.0.68"],
          timeout: { catalog: 30_000, execution: 60_000 },
        },
        linear: {
          type: "remote",
          url: "https://mcp.linear.app/sse",
          oauth: { client_id: "abc" },
          codemode: true,
        },
      },
    });

    expect(config.mcp?.servers?.["playwright"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@0.0.68"],
      timeout: { catalog: 30_000, execution: 60_000 },
      codemode: false,
    });
    expect(config.mcp?.servers?.["linear"]).toEqual({
      type: "remote",
      url: "https://mcp.linear.app/sse",
      oauth: { client_id: "abc" },
      codemode: true,
    });
  });

  test("step MCP tools are denied to every agent except build", () => {
    const config = buildScarnOverrideConfig({
      baseConfig: BASELINE,
      stepMcpServers: {
        playwright: { type: "local", command: ["npx", "@playwright/mcp"] },
      },
    });

    expect(config.permissions?.slice(0, 3)).toEqual(BASELINE.permissions);
    expect(config.permissions?.at(-1)).toEqual({
      action: "playwright_*",
      resource: "*",
      effect: "deny",
    });
    expect(config.agents?.["build"]?.permissions).toEqual([
      { action: "playwright_*", resource: "*", effect: "allow" },
    ]);

    expect(
      evaluate(effectiveRules(config, "build"), "playwright_browser_navigate"),
    ).toBe("allow");
    for (const agent of ["plan", "general", "explore"]) {
      expect(
        evaluate(effectiveRules(config, agent), "playwright_browser_navigate"),
        agent,
      ).toBe("deny");
    }
    expect(evaluate(effectiveRules(config, "plan"), "read")).toBe("allow");
    expect(evaluate(effectiveRules(config, "build"), "question")).toBe("deny");
    expect(
      evaluate(effectiveRules(config, "build"), "scarn-submit-step-findings"),
    ).toBe("allow");
  });

  test("a server's deny rule does not catch another server sharing its prefix", () => {
    const config = buildScarnOverrideConfig({
      baseConfig: BASELINE,
      stepMcpServers: {
        fix: { type: "local", command: ["fix"] },
      },
    });
    expect(evaluate(effectiveRules(config, "plan"), "fix_echo")).toBe("deny");
    expect(evaluate(effectiveRules(config, "plan"), "fixture_echo")).toBe(
      "allow",
    );
  });

  test("tool action patterns follow OpenCode's name sanitising", () => {
    expect(mcpToolActionPattern("my-fix.v2")).toBe("my-fix_v2_*");
    expect(mcpToolActionPattern("playwright")).toBe("playwright_*");
  });

  test("the step prompt becomes the build agent's system prompt", () => {
    const config = buildScarnOverrideConfig({
      baseConfig: BASELINE,
      agentPromptText: "Execute the Scarn step.",
    });
    expect(config.agents?.["build"]).toEqual({
      system: "Execute the Scarn step.",
      permissions: [],
    });
    expect(config.permissions).toEqual(BASELINE.permissions);
  });

  test("keeps existing build agent rules ahead of the step allow rules", () => {
    const config = buildScarnOverrideConfig({
      baseConfig: {
        ...BASELINE,
        agents: {
          build: {
            description: "Baseline build agent",
            permissions: [
              { action: "shell", resource: "rm *", effect: "deny" },
            ],
          },
        },
      },
      stepMcpServers: { datadog: { type: "local", command: ["dd"] } },
    });
    expect(config.agents?.["build"]).toEqual({
      description: "Baseline build agent",
      permissions: [
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "datadog_*", resource: "*", effect: "allow" },
      ],
    });
  });

  test("passes the baseline plugins through unchanged", () => {
    const plugins = [
      { package: "opencode-helicone-session", options: { project: "abc" } },
    ];
    const config = buildScarnOverrideConfig({
      baseConfig: { ...BASELINE, plugins },
    });
    expect(config.plugins).toEqual(plugins);
  });

  test("AGENT_DEFAULT_MODEL sets model", () => {
    process.env["AGENT_DEFAULT_MODEL"] = "openai/gpt-5.4";
    expect(buildScarnOverrideConfig({ baseConfig: BASELINE }).model).toBe(
      "openai/gpt-5.4",
    );
  });

  test("does not mutate the baseline", () => {
    const baseConfig = structuredClone(BASELINE);
    buildScarnOverrideConfig({
      baseConfig,
      stepMcpServers: { a: { type: "local", command: ["a"] } },
      agentPromptText: "x",
    });
    expect(baseConfig).toEqual(BASELINE);
  });
});
