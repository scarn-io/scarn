import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  defineMcp,
  mcpHandleCatalog,
  mcpTool,
  mcpToolCatalog,
  Runtime,
  toStepSpec,
  type StepDefinitionSpec,
} from "../src/definitions/steps";
import { MCP_TOOL_CONTENT_RESULT_SCHEMA } from "../src/contracts/pipeline-document/built-ins";
import { isStepDefinitionSpec } from "../src/push/code-step-lookup";
import { validateDefinitionSpecs } from "../src/definitions/validation";
import { definePipeline, type McpToolContentResult } from "../src/pipelines";
import {
  notion,
  notionTools,
  searchInputJsonSchema,
  searchOutputJsonSchema,
} from "./mcp-tool-step-fixtures";

describe("withTools", () => {
  test("binds every catalog entry as a tool reference", () => {
    expect(Object.keys(notion.tools)).toEqual(["search", "createPages"]);
    expect(notion.tools.search.tool).toBe(notionTools.tools.search);
    expect(notion.tools.search.handle).toBe(notion);
    expect(Object.isFrozen(notion)).toBe(true);
  });

  test("a builder method keeps the tools; withTools again replaces them", () => {
    const local = defineMcp({
      type: "local",
      name: "ops",
      command: ["ops-mcp"],
      healthChecks: { ping: { tool: "ping" } },
    }).withTools(notionTools);
    const disabled = local.disableAllChecks();
    expect(Object.keys(disabled.tools)).toEqual(["search", "createPages"]);
    expect(disabled.tools.search.handle).toBe(disabled);

    const other = mcpToolCatalog({
      source: { server: "ops" },
      tools: { ping: mcpTool({ name: "ping", input: z.object({}) }) },
    });
    const replaced = disabled.withTools(other);
    expect(Object.keys(replaced.tools)).toEqual(["ping"]);
    expectTypeOf(replaced.tools).toHaveProperty("ping");
    // @ts-expect-error the earlier catalog's tools are gone
    void replaced.tools.search;
  });

  test("mcpHandleCatalog reads the bound catalog, through builder methods", () => {
    expect(mcpHandleCatalog(notion)).toBe(notionTools);
    expect(mcpHandleCatalog(notion.disableAllChecks())).toBe(notionTools);
    expect(mcpHandleCatalog(defineMcp({ type: "ref", name: "bare" }))).toBe(
      undefined,
    );
  });

  test("a handle without tools has no tools property", () => {
    const bare = defineMcp({ type: "ref", name: "bare" });
    expect("tools" in bare).toBe(false);
    // @ts-expect-error no catalog bound yet
    void bare.tools;
  });

  test("rejects a value that isn't a catalog", () => {
    expect(() =>
      defineMcp({ type: "ref", name: "x" }).withTools(
        // @ts-expect-error not a catalog
        { tools: {} },
      ),
    ).toThrow(/expected a catalog from mcpToolCatalog/);
  });
});

describe("toolRef.step() types", () => {
  test("a pass-through step takes the tool's input and returns its output", () => {
    const step = notion.tools.search.step();
    expectTypeOf(step.__input).toEqualTypeOf<{
      query: string;
      limit?: number | undefined;
    }>();
    expectTypeOf(step.__result).toEqualTypeOf<{
      results: { title: string }[];
    }>();
  });

  test("a tool without an output returns the MCP content result", () => {
    const step = notion.tools.createPages.step();
    expectTypeOf(step.__result).toEqualTypeOf<McpToolContentResult>();
  });

  test("an adapted step takes its own input and types args from the tool", () => {
    const step = notion.tools.createPages.step({
      key: "file-bug-page",
      inputSchema: z.object({ title: z.string(), summary: z.string() }),
      args: ({ input, env }) => {
        expectTypeOf(input).toEqualTypeOf<{ title: string; summary: string }>();
        expectTypeOf(env.NOTION_BUGS_PAGE).toEqualTypeOf<string>();
        return {
          parent: { page_id: env.NOTION_BUGS_PAGE },
          pages: [{ title: `Bug: ${input.title}`, content: input.summary }],
        };
      },
      environment: { vars: { NOTION_BUGS_PAGE: "abc123" } },
    });
    expectTypeOf(step.__input).toEqualTypeOf<{
      title: string;
      summary: string;
    }>();
    expectTypeOf(step.errors).toEqualTypeOf<readonly never[]>();
  });

  test("a wrong args shape fails to compile", () => {
    notion.tools.createPages.step({
      key: "bad-args",
      inputSchema: z.object({ title: z.string() }),
      // @ts-expect-error pages is missing and parent.page_id must be a string
      args: ({ input }) => ({ parent: { page_id: 1 }, title: input.title }),
    });
  });

  test("errors and retry are typed as for codeStep", () => {
    notion.tools.search.step({
      key: "typed-errors",
      errors: ["NotFound"],
      retry: [{ on: ["NotFound", "Scarn.McpUnavailable"], maxAttempts: 2 }],
    });
    expect(() =>
      notion.tools.search.step({
        key: "typed-errors-bad",
        errors: ["NotFound"],
        retry: [{ on: ["Nope" as "NotFound"], maxAttempts: 2 }],
      }),
    ).toThrow(/neither a built-in error nor one the step declares/);
  });
});

describe("toolRef.step() specs", () => {
  test("a pass-through step with an output schema", () => {
    const step = notion.tools.search.step();
    expect(step.kind).toBe("mcp_tool");
    expect(isStepDefinitionSpec(step)).toBe(true);
    expect(toStepSpec(step)).toEqual({
      key: "notion-notion-search",
      name: "Search",
      description: "Search the workspace",
      version: 1,
      kind: "mcp_tool",
      status: "active",
      environment: {
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
        envJson: null,
      },
      prompt: null,
      inputSchemaJson: searchInputJsonSchema,
      resultSchemaJson: searchOutputJsonSchema,
      opencodeMcpJson: {
        notion: { type: "ref", auth: { connection: "notion" } },
      },
      healthChecksJson: null,
      errors: [],
      retryJson: [],
      toolCall: {
        server: "notion",
        tool: "notion-search",
        argsTemplate: "{{input}}",
        toolSchemas: {
          input: searchInputJsonSchema,
          output: searchOutputJsonSchema,
        },
      },
    });
  });

  test("an adapted step without an output schema", () => {
    const step = notion.tools.createPages.step({
      key: "file-bug-page",
      name: "File bug page",
      inputSchema: z.object({ title: z.string(), summary: z.string() }),
      args: ({ input, env }) => ({
        parent: { page_id: env.NOTION_BUGS_PAGE },
        pages: [{ title: `Bug: ${input.title}`, content: input.summary }],
      }),
      environment: { vars: { NOTION_BUGS_PAGE: "abc123" } },
      errors: ["Duplicate"],
      retry: [{ on: ["Scarn.McpUnavailable"], maxAttempts: 1 }],
      concurrency: { max: 1, waiting: 0 },
      status: "draft",
    });
    const spec = toStepSpec(step);
    expect(spec).toEqual({
      key: "file-bug-page",
      name: "File bug page",
      description: null,
      version: 1,
      kind: "mcp_tool",
      status: "draft",
      environment: {
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
        envJson: [
          {
            source: "value",
            name: "NOTION_BUGS_PAGE",
            value: "abc123",
            secret: false,
          },
        ],
      },
      prompt: null,
      inputSchemaJson: expect.objectContaining({
        type: "object",
        required: ["title", "summary"],
      }) as Record<string, unknown>,
      resultSchemaJson: MCP_TOOL_CONTENT_RESULT_SCHEMA as Record<
        string,
        unknown
      >,
      opencodeMcpJson: {
        notion: { type: "ref", auth: { connection: "notion" } },
      },
      healthChecksJson: null,
      errors: ["Duplicate"],
      retryJson: [{ on: ["Scarn.McpUnavailable"], maxAttempts: 1 }],
      concurrency: { max: 1, waiting: 0 },
      toolCall: {
        server: "notion",
        tool: "notion_create_pages",
        argsTemplate: {
          parent: { page_id: "{{env.NOTION_BUGS_PAGE}}" },
          pages: [
            { title: "Bug: {{input.title}}", content: "{{input.summary}}" },
          ],
        },
        toolSchemas: {
          input: notionTools.tools.createPages.inputJsonSchema,
          output: null,
        },
      },
    });
    expect(validateDefinitionSpecs([spec])).toEqual([]);
  });

  test("the runtime defaults by transport and an explicit one wins", () => {
    const local = defineMcp({
      type: "local",
      name: "files",
      command: ["files-mcp"],
    }).withTools(notionTools);
    const remote = defineMcp({
      type: "remote",
      name: "api",
      url: "https://mcp.example.com",
    }).withTools(notionTools);
    const ref = defineMcp({ type: "ref", name: "repo" }).withTools(notionTools);
    const runtimeOf = (env: StepDefinitionSpec["environment"]) =>
      env?.kind === "inline" ? env.runtime : undefined;
    expect(runtimeOf(local.tools.search.step().environment)).toEqual({
      kind: "devcontainer",
    });
    expect(runtimeOf(remote.tools.search.step().environment)).toEqual({
      kind: "managed",
      id: "bun1",
    });
    expect(runtimeOf(ref.tools.search.step().environment)).toEqual({
      kind: "devcontainer",
    });
    expect(
      runtimeOf(
        local.tools.search.step({ environment: { runtime: Runtime.host() } })
          .environment,
      ),
    ).toEqual({ kind: "host" });
  });

  test("one catalog bound to two handles makes two independent steps", () => {
    const dev = defineMcp({
      type: "local",
      name: "notion-dev",
      command: ["notion-mcp"],
    }).withTools(notionTools);
    const devSearch = dev.tools.search.step();
    const prodSearch = notion.tools.search.step();
    expect(devSearch.key).toBe("notion-dev-notion-search");
    expect(prodSearch.key).toBe("notion-notion-search");
    expect(devSearch.toolCall?.server).toBe("notion-dev");
    expect(prodSearch.toolCall?.server).toBe("notion");
    expect(Object.keys(devSearch.opencodeMcpJson ?? {})).toEqual([
      "notion-dev",
    ]);
    expect(devSearch.opencodeMcpJson?.["notion-dev"]).toMatchObject({
      type: "local",
    });
    expect(toStepSpec(devSearch).toolCall?.toolSchemas).toEqual(
      toStepSpec(prodSearch).toolCall?.toolSchemas,
    );
  });

  test("the step is callable in a pipeline", () => {
    const search = notion.tools.search.step();
    const pipeline = definePipeline({
      key: "search-only",
      start: search({ query: "bugs" }),
      flow: [],
    });
    expect(pipeline.document.nodes["notion-notion-search"]).toMatchObject({
      step: "notion-notion-search",
    });
  });
});
