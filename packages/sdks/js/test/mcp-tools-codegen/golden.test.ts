/**
 * Golden tests: each fixture's lock and generated catalog match the files in
 * `golden/`. Regenerate them with `bun test/mcp-tools-codegen/update-golden.ts`.
 * The generated catalogs are also imported, so they must typecheck and build.
 */
import { describe, expect, expectTypeOf, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { z } from "zod";
import {
  isMcpToolCatalog,
  type McpToolInput,
  type McpToolOutput,
} from "../../src/definitions/steps";
import { goldenCases } from "./golden-cases";
import { edgeCasesTools } from "./golden/edge-cases.tools";
import { notionTools } from "./golden/notion.tools";

describe("MCP tool codegen golden files", () => {
  for (const golden of goldenCases()) {
    test(`${golden.server} lock`, () => {
      expect(golden.lockText).toBe(readFileSync(golden.lockPath, "utf8"));
    });

    test(`${golden.server} catalog`, () => {
      expect(golden.catalogSource).toBe(
        readFileSync(golden.catalogPath, "utf8"),
      );
    });
  }

  test("the edge-case catalog warns about the collision and unsupported schemas", () => {
    const edge = goldenCases().find((golden) => golden.server === "edge-cases");
    expect(edge?.warnings).toEqual([
      'MCP tool "get_item" maps to catalog key "getItem", which is taken; using "getItem2"',
      'MCP tool "get-item" input schema: patternProperties is typed as unknown (the JSON Schema still validates it at runtime)',
      'MCP tool "walk tree" input schema: recursive $ref #/definitions/node is typed as unknown (the JSON Schema still validates it at runtime)',
    ]);
  });

  test("the notion catalog has no warnings", () => {
    const notion = goldenCases().find((golden) => golden.server === "notion");
    expect(notion?.warnings).toEqual([]);
  });
});

describe("generated catalogs at runtime", () => {
  test("build a catalog sourced from the lock", () => {
    const [notion] = goldenCases();
    expect(isMcpToolCatalog(notionTools)).toBe(true);
    expect(notionTools.source).toEqual({
      server: "notion",
      lockHash: notion?.lock.hash,
    });
    expect(Object.keys(notionTools.tools)).toEqual(["createPages", "search"]);
    expect(isMcpToolCatalog(edgeCasesTools)).toBe(true);
    expect(Object.keys(edgeCasesTools.tools)).toEqual([
      "getItem",
      "getItem2",
      "walkTree",
    ]);
  });

  test("embed the server's JSON Schemas verbatim", () => {
    const [notion] = goldenCases();
    for (const tool of notion?.lock.tools ?? []) {
      const generated = Object.values(notionTools.tools).find(
        (entry) => entry.name === tool.name,
      );
      expect(generated?.inputJsonSchema).toEqual(tool.inputSchema);
      expect(generated?.outputJsonSchema).toEqual(tool.outputSchema ?? null);
    }
  });

  test("the zod types accept what the JSON Schemas accept", () => {
    expect(
      notionTools.tools.search.input.parse({ query: "q", limit: 2 }),
    ).toEqual({ query: "q", limit: 2 });
    expect(() =>
      notionTools.tools.search.input.parse({ query: "q", extra: 1 }),
    ).toThrow();
    expect(
      notionTools.tools.createPages.input.parse({
        parent: { database_id: "d" },
        pages: [{ title: "t" }],
      }),
    ).toEqual({ parent: { database_id: "d" }, pages: [{ title: "t" }] });
  });
});

describe("generated catalogs' types", () => {
  test("infer tool input and output", () => {
    expectTypeOf<
      z.infer<McpToolInput<typeof notionTools.tools.search>>
    >().toEqualTypeOf<{
      query: string;
      limit?: number | undefined;
      filter?: "page" | "database" | undefined;
    }>();
    expectTypeOf<
      z.infer<McpToolOutput<typeof notionTools.tools.search>>
    >().toEqualTypeOf<{
      results: {
        id: string;
        title: string;
        url?: string | null | undefined;
      }[];
      hasMore?: boolean | undefined;
    }>();
    expectTypeOf<
      McpToolOutput<typeof notionTools.tools.createPages>
    >().toEqualTypeOf<undefined>();
    expectTypeOf<
      z.infer<McpToolInput<typeof edgeCasesTools.tools.walkTree>>
    >().toEqualTypeOf<{
      root: { name: string; children?: unknown[] | undefined };
    }>();
  });
});
