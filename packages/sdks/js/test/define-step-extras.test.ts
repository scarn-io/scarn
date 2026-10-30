import { describe, expect, test } from "bun:test";
import { defineStep } from "../src/definitions/steps/define-step";

describe("defineStep — healthChecks", () => {
  test("healthChecksJson defaults to null when not provided", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
    });
    expect(spec.healthChecksJson).toBeNull();
  });

  test("maps healthChecks to healthChecksJson", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      healthChecks: [
        { tool: "my_plugin_tool", severity: "warn", timeoutSeconds: 5 },
      ],
    });

    expect(spec.healthChecksJson).toEqual([
      { tool: "my_plugin_tool", severity: "warn", timeoutSeconds: 5 },
    ]);
  });

  test("rejects a hand-written MCP check", () => {
    expect(() =>
      defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        // @ts-expect-error MCP checks are declared with defineMcp
        healthChecks: [{ mcp: "x", tool: "y" }],
      }),
    ).toThrow(
      /Step "my-step" healthChecks: .*mcp.*declared on the server with defineMcp/,
    );
  });

  test("rejects mcpServers", () => {
    expect(() =>
      defineStep({
        key: "my-step",
        name: "My Step",
        agentPrompt: "Do the work.",
        // @ts-expect-error mcpServers was replaced by defineMcp + mcps
        mcpServers: { x: { type: "local", command: ["x"] } },
      }),
    ).toThrow(/Step "my-step": mcpServers is not supported\. .*defineMcp/);
  });

  test("explicit null healthChecks stores null", () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      healthChecks: null,
    });
    expect(spec.healthChecksJson).toBeNull();
  });

  test('accepts a kind: "cli" check and passes it through unchanged', () => {
    const spec = defineStep({
      key: "my-step",
      name: "My Step",
      agentPrompt: "Do the work.",
      healthChecks: [{ kind: "cli", command: ["gh", "--version"] }],
    });

    expect(spec.healthChecksJson).toEqual([
      { kind: "cli", command: ["gh", "--version"] },
    ]);
  });
});
