import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defaultMcpToolStepKey,
  defineMcp,
  Env,
  toStepSpec,
} from "../src/definitions/steps";
import { defineEnvironment } from "../src/definitions/environments/define-environment";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { notion, notionTools } from "./mcp-tool-step-fixtures";

describe("default keys", () => {
  test("kebab-cases the handle and tool names", () => {
    expect(defaultMcpToolStepKey("Notion", "createPages")).toBe(
      "notion-create-pages",
    );
    expect(defaultMcpToolStepKey("my_server", "API.search")).toBe(
      "my-server-api-search",
    );
  });

  test("rejects a default key that is empty after normalising or too long", () => {
    expect(() => defaultMcpToolStepKey("—", "…")).toThrow(/\.step\(\{ key/);
    expect(() => defaultMcpToolStepKey("server", "x".repeat(80))).toThrow(
      /longer than 64 characters.*\.step\(\{ key/,
    );
  });

  test("an explicit key skips the default", () => {
    const long = defineMcp({ type: "ref", name: "x".repeat(80) }).withTools(
      notionTools,
    );
    expect(() => long.tools.search.step()).toThrow(/\.step\(\{ key/);
    expect(long.tools.search.step({ key: "short" }).key).toBe("short");
  });
});

describe("define-time rejections", () => {
  test("a handle with health checks", () => {
    const checked = defineMcp({
      type: "ref",
      name: "checked",
      healthChecks: { ping: { tool: "ping" } },
    }).withTools(notionTools);
    expect(() => checked.tools.search.step()).toThrow(
      /run no health checks.*"ping"/,
    );
    expect(() => checked.disableAllChecks().tools.search.step()).not.toThrow();
  });

  test("a secret env token in args", () => {
    expect(() =>
      notion.tools.createPages.step({
        key: "secret-args",
        inputSchema: z.object({}),
        args: ({ env }) => ({
          parent: {
            page_id: (env as Record<string, string>).NOTION_TOKEN as string,
          },
          pages: [],
        }),
        environment: { vars: { NOTION_TOKEN: Env.secret("NOTION_TOKEN") } },
      }),
    ).toThrow(/secret var/);
  });

  test("an undeclared env token in args", () => {
    expect(() =>
      notion.tools.createPages.step({
        key: "undeclared-args",
        inputSchema: z.object({}),
        args: () => ({
          parent: { page_id: "{{env.MISSING}}" },
          pages: [],
        }),
      }),
    ).toThrow(/does not declare/);
  });

  test("inputSchema without args", () => {
    expect(() =>
      // @ts-expect-error inputSchema needs args
      notion.tools.search.step({ inputSchema: z.object({ q: z.string() }) }),
    ).toThrow(/inputSchema needs args/);
  });

  test("args without inputSchema", () => {
    expect(() =>
      // @ts-expect-error args needs inputSchema
      notion.tools.search.step({ args: () => ({ query: "x" }) }),
    ).toThrow(/args needs an inputSchema/);
  });

  test("args that transform a value", () => {
    expect(() =>
      notion.tools.search.step({
        key: "transform",
        inputSchema: z.object({ q: z.string() }),
        args: ({ input }) => ({ query: input.q.toUpperCase() }),
      }),
    ).toThrow(/codeStep/);
  });

  test("an environment handle's secret var in args", () => {
    const environment = defineEnvironment({
      name: "notion-env",
      vars: { NOTION_SECRET: Env.secret("NOTION_SECRET") },
    });
    expect(() =>
      notion.tools.createPages.step({
        key: "handle-secret-args",
        inputSchema: z.object({}),
        args: ({ env }) => ({
          parent: {
            page_id: (env as Record<string, string>).NOTION_SECRET as string,
          },
          pages: [],
        }),
        environment,
      }),
    ).toThrow(/secret var/);
  });
});

describe("validateDefinitionSpecs on mcp_tool specs", () => {
  test("flags a hand-built spec with a missing tool call or a second server", () => {
    const spec = toStepSpec(notion.tools.search.step());
    const missing = { ...spec, toolCall: undefined };
    const twoServers = {
      ...spec,
      opencodeMcpJson: {
        ...spec.opencodeMcpJson,
        other: { type: "ref" as const },
      },
    };
    const onCode = { ...spec, kind: "code" as const, resultSchemaJson: {} };
    const messages = validateDefinitionSpecs([
      { ...missing, key: "a" },
      { ...twoServers, key: "b" },
      { ...onCode, key: "c" },
    ]).map((issue) => issue.message);
    expect(messages).toEqual([
      'Step "a": an mcp_tool step needs a toolCall.',
      expect.stringContaining(
        'Step "b": an mcp_tool step declares exactly one MCP server',
      ) as string,
      'Step "c": only an mcp_tool step has a toolCall, not code.',
    ]);
  });
});
