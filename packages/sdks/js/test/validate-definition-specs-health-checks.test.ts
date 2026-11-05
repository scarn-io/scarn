import { describe, expect, test } from "bun:test";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { stepSpecWithOverrides } from "./definition-spec-fixtures";

/**
 * `validateDefinitionSpecs — health checks` — split out of
 * `validate-definition-specs.test.ts` to keep that file under the repo's
 * `max-lines` limit; see that file for the rest of `validateDefinitionSpecs`'s
 * own coverage (route targets, signal bindings, `assertValidDefinitionSpecs`).
 */
describe("validateDefinitionSpecs — health checks", () => {
  // Matches the shipped Playwright template (`mcp: "playwright"`), whose
  // MCP tools are themselves named "browser_*".
  const withMcp = (
    healthChecksJson: NonNullable<
      ReturnType<typeof stepSpecWithOverrides>["healthChecksJson"]
    >,
  ) =>
    stepSpecWithOverrides("browser-step", {
      opencodeMcpJson: {
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp"],
        },
      },
      healthChecksJson,
    });

  test("accepts a check naming a declared MCP server with a bare tool name", () => {
    expect(
      validateDefinitionSpecs([
        withMcp([
          {
            mcp: "playwright",
            tool: "browser_navigate",
            args: { url: "about:blank" },
            severity: "required",
            timeoutSeconds: 15,
          },
        ]),
      ]),
    ).toEqual([]);
  });

  test("accepts a check naming a server declared as a ref", () => {
    expect(
      validateDefinitionSpecs([
        stepSpecWithOverrides("ref-step", {
          opencodeMcpJson: { postgres: { type: "ref" } },
          healthChecksJson: [
            {
              mcp: "postgres",
              tool: "list_schemas",
              severity: "required",
              timeoutSeconds: 15,
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test("accepts a check with no mcp qualifier (plugin/standalone/built-in tool)", () => {
    expect(
      validateDefinitionSpecs([
        stepSpecWithOverrides("plugin-step", {
          healthChecksJson: [
            {
              tool: "my_plugin_tool",
              severity: "required",
              timeoutSeconds: 15,
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test("rejects a check naming an MCP server not declared in mcps", () => {
    const issues = validateDefinitionSpecs([
      withMcp([
        {
          mcp: "typo",
          tool: "browser_navigate",
          severity: "required",
          timeoutSeconds: 15,
        },
      ]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("health-check-mcp-server");
    expect(issues[0]?.message).toContain(
      'Step "browser-step" health check #1 ("browser_navigate")',
    );
    expect(issues[0]?.message).toContain(
      'names MCP server "typo", but the step declares no such server in mcps.',
    );
    expect(issues[0]?.message).toContain("Declared servers: playwright.");
  });

  // Microsoft's PostgreSQL MCP server's own tools are named `postgres_mcp_*`,
  // so a tool name starting with the server key is not necessarily a
  // double-qualification mistake — that hint is left to the worker, which
  // only offers it once the call has actually failed.
  test("accepts a tool whose real name starts with the server key", () => {
    expect(
      validateDefinitionSpecs([
        stepSpecWithOverrides("postgres-step", {
          opencodeMcpJson: { postgres: { type: "ref" } },
          healthChecksJson: [
            {
              mcp: "postgres",
              tool: "postgres_mcp_connect",
              args: { profileId: "default" },
              severity: "required",
              timeoutSeconds: 15,
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test("uses the check's name for the label when provided", () => {
    const issues = validateDefinitionSpecs([
      withMcp([
        {
          mcp: "typo",
          tool: "browser_navigate",
          name: "Browser smoke test",
          severity: "required",
          timeoutSeconds: 15,
        },
      ]),
    ]);
    expect(issues[0]?.message).toContain(
      'health check #1 ("Browser smoke test")',
    );
  });

  test("stays quiet for a step declaring no health checks", () => {
    expect(
      validateDefinitionSpecs([stepSpecWithOverrides("no-checks")]),
    ).toEqual([]);
  });

  test('accepts a step declaring only a kind: "cli" check', () => {
    expect(
      validateDefinitionSpecs([
        stepSpecWithOverrides("cli-step", {
          healthChecksJson: [
            {
              kind: "cli",
              command: ["gh", "--version"],
              severity: "required",
              timeoutSeconds: 15,
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  test("accepts a step declaring both a tool check and a cli check together", () => {
    expect(
      validateDefinitionSpecs([
        withMcp([
          {
            mcp: "playwright",
            tool: "browser_navigate",
            args: { url: "about:blank" },
            severity: "required",
            timeoutSeconds: 15,
          },
          {
            kind: "cli",
            command: ["gh", "--version"],
            severity: "required",
            timeoutSeconds: 15,
          },
        ]),
      ]),
    ).toEqual([]);
  });

  test("a cli check's absence of mcp/tool never triggers the mcp-server check", () => {
    const issues = validateDefinitionSpecs([
      stepSpecWithOverrides("cli-only-step", {
        healthChecksJson: [
          {
            kind: "cli",
            command: ["gh", "--version"],
            severity: "required",
            timeoutSeconds: 15,
          },
        ],
      }),
    ]);
    expect(
      issues.some((issue) => issue.check === "health-check-mcp-server"),
    ).toBe(false);
  });
});
