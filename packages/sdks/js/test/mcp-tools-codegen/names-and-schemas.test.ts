import { describe, expect, test } from "bun:test";
import {
  jsonSchemaToZod,
  mcpToolCatalogExportName,
  mcpToolCatalogFileName,
  mcpToolKeys,
  mcpToolLockFileName,
} from "../../src/mcp-tools/codegen";
import { printDoc } from "../../src/mcp-tools/codegen/doc-printer";
import type { JsonSchema } from "../../src/contracts/pipeline-document/json";

describe("names", () => {
  test("file and export names", () => {
    expect(mcpToolLockFileName("notion")).toBe("notion.lock.json");
    expect(mcpToolCatalogFileName("notion")).toBe("notion.tools.ts");
    expect(mcpToolCatalogExportName("notion")).toBe("notionTools");
    expect(mcpToolCatalogExportName("my-server")).toBe("myServerTools");
    expect(mcpToolCatalogExportName("1password")).toBe("_1passwordTools");
  });

  test("strip the server prefix, camel-case and suffix collisions", () => {
    expect(
      mcpToolKeys("notion", [
        "notion-search",
        "notion_create_pages",
        "fetchURL",
        "notion-",
        "delete",
        "2fa",
        "search",
      ]),
    ).toEqual({
      keys: [
        { name: "notion-search", key: "search" },
        { name: "notion_create_pages", key: "createPages" },
        { name: "fetchURL", key: "fetchURL" },
        { name: "notion-", key: "notion" },
        { name: "delete", key: "delete" },
        { name: "2fa", key: "_2fa" },
        { name: "search", key: "search2" },
      ],
      warnings: [
        'MCP tool "search" maps to catalog key "search", which is taken; using "search2"',
      ],
    });
  });
});

function zodSource(schema: JsonSchema) {
  const { doc, unsupported } = jsonSchemaToZod(schema);
  return { source: printDoc(doc), unsupported };
}

describe("jsonSchemaToZod", () => {
  const cases: [string, JsonSchema, string][] = [
    ["true", true, "z.unknown()"],
    ["false", false, "z.never()"],
    ["empty", {}, "z.unknown()"],
    ["string", { type: "string", minLength: 1 }, "z.string()"],
    ["integer", { type: "integer" }, "z.int()"],
    ["null", { type: "null" }, "z.null()"],
    [
      "type array",
      { type: ["string", "number", "null"] },
      "z.nullable(z.union([z.string(), z.number()]))",
    ],
    ["const", { const: "x" }, 'z.literal("x")'],
    ["string enum", { enum: ["a", "b"] }, 'z.enum(["a", "b"])'],
    [
      "nullable",
      { type: "boolean", nullable: true },
      "z.nullable(z.boolean())",
    ],
    ["untyped array", { type: "array" }, "z.array(z.unknown())"],
    [
      "record",
      { type: "object", additionalProperties: { type: "number" } },
      "z.record(z.string(), z.number())",
    ],
    [
      "loose object",
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: { type: "string" },
      },
      "z.looseObject({ a: z.string() })",
    ],
    ["single allOf", { allOf: [{ type: "string" }] }, "z.string()"],
    [
      "quoted key",
      { type: "object", properties: { "a-b": { type: "string" } } },
      'z.object({ "a-b": z.optional(z.string()) })',
    ],
    [
      "$defs ref",
      { $ref: "#/$defs/a", $defs: { a: { type: "string" } } },
      "z.string()",
    ],
  ];
  for (const [name, schema, expected] of cases) {
    test(name, () => {
      expect(zodSource(schema)).toEqual({ source: expected, unsupported: [] });
    });
  }

  const unsupportedCases: [string, JsonSchema, string][] = [
    ["remote $ref", { $ref: "https://example.com/s.json" }, "unresolved $ref"],
    ["missing $ref", { $ref: "#/$defs/nope" }, "unresolved $ref"],
    ["not", { not: { type: "string" } }, "not"],
    ["if", { if: {}, then: {} }, "if"],
    ["multi allOf", { allOf: [{}, {}] }, "allOf"],
    ["tuple", { type: "array", prefixItems: [{}] }, "prefixItems"],
    ["object const", { const: { a: 1 } }, "object const"],
  ];
  for (const [name, schema, feature] of unsupportedCases) {
    test(`unsupported: ${name}`, () => {
      const { source, unsupported } = zodSource(schema);
      expect(source).toStartWith("z.unknown() /* unsupported: ");
      expect(unsupported[0]).toStartWith(feature);
    });
  }
});
