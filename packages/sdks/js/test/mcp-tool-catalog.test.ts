import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  isMcpTool,
  isMcpToolCatalog,
  mcpTool,
  mcpToolCatalog,
  type McpToolInput,
  type McpToolOutput,
} from "../src/definitions/mcp-tools/catalog";

const searchInputJsonSchema = {
  type: "object",
  properties: { query: { type: "string", minLength: 1 } },
  required: ["query"],
  additionalProperties: false,
};

const search = mcpTool({
  name: "notion-search",
  title: "Search",
  description: "Search the workspace",
  input: z.object({ query: z.string() }),
  inputJsonSchema: searchInputJsonSchema,
  output: z.object({ results: z.array(z.object({ title: z.string() })) }),
  outputJsonSchema: {
    type: "object",
    properties: { results: { type: "array" } },
    required: ["results"],
  },
});

const createPages = mcpTool({
  name: "notion-create-pages",
  input: z.object({ pages: z.array(z.object({ title: z.string() })) }),
});

describe("mcpTool", () => {
  test("keeps the given JSON Schemas verbatim", () => {
    expect(search.inputJsonSchema).toEqual(searchInputJsonSchema);
    expect(search.inputJsonSchema).not.toBe(searchInputJsonSchema);
    expect(search.outputJsonSchema).toEqual({
      type: "object",
      properties: { results: { type: "array" } },
      required: ["results"],
    });
    expect(search.title).toBe("Search");
    expect(search.description).toBe("Search the workspace");
  });

  test("derives JSON Schema from zod when none is given; output is optional", () => {
    expect(createPages.inputJsonSchema).toMatchObject({
      type: "object",
      required: ["pages"],
    });
    expect(createPages.output).toBeUndefined();
    expect(createPages.outputJsonSchema).toBeNull();
    expect(createPages.title).toBeNull();
    expect(createPages.description).toBeNull();
  });

  test("is deeply frozen", () => {
    expect(Object.isFrozen(search)).toBe(true);
    expect(Object.isFrozen(search.inputJsonSchema)).toBe(true);
    expect(
      Object.isFrozen(
        (search.inputJsonSchema as { properties: object }).properties,
      ),
    ).toBe(true);
  });

  test("rejects an empty name and an output JSON Schema without output", () => {
    expect(() => mcpTool({ name: " ", input: z.object({}) })).toThrow(
      "name must not be empty",
    );
    expect(() =>
      // @ts-expect-error outputJsonSchema needs output
      mcpTool({ name: "x", input: z.object({}), outputJsonSchema: {} }),
    ).toThrow("outputJsonSchema needs an output zod type");
  });

  test("input is required", () => {
    // @ts-expect-error input is required
    expect(() => mcpTool({ name: "x" })).toThrow();
  });

  test("infers input and output types", () => {
    expectTypeOf<z.infer<McpToolInput<typeof search>>>().toEqualTypeOf<{
      query: string;
    }>();
    expectTypeOf<
      z.infer<NonNullable<McpToolOutput<typeof search>>>
    >().toEqualTypeOf<{ results: { title: string }[] }>();
    expectTypeOf<
      McpToolOutput<typeof createPages>
    >().toEqualTypeOf<undefined>();
  });
});

describe("mcpToolCatalog", () => {
  const catalog = mcpToolCatalog({
    source: { server: "notion", lockHash: "sha256:abc" },
    tools: { search, createPages },
  });

  test("is frozen data keyed by property name", () => {
    expect(isMcpToolCatalog(catalog)).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.tools)).toBe(true);
    expect(Object.isFrozen(catalog.source)).toBe(true);
    expect(catalog.source).toEqual({
      server: "notion",
      lockHash: "sha256:abc",
    });
    expect(catalog.tools.search).toBe(search);
    expect(isMcpTool(catalog.tools.createPages)).toBe(true);
    expectTypeOf(catalog.tools.search).toEqualTypeOf<typeof search>();
  });

  test("rejects entries not made with mcpTool and duplicate tool names", () => {
    expect(() =>
      mcpToolCatalog({
        source: { server: "notion" },
        // @ts-expect-error not an mcpTool
        tools: { bad: { name: "x" } },
      }),
    ).toThrow("tools.bad must be made with mcpTool()");
    expect(() =>
      mcpToolCatalog({
        source: { server: "notion" },
        tools: { a: search, b: search },
      }),
    ).toThrow('tools.a and tools.b both name the tool "notion-search"');
    expect(() => mcpToolCatalog({ source: { server: "" }, tools: {} })).toThrow(
      "source.server must not be empty",
    );
  });
});
