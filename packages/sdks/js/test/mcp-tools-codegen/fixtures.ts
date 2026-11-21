/** Listed tools for the MCP tool codegen tests. */
import type { ListedMcpToolInput } from "../../src/mcp-tools/codegen";

export const LISTED_AT = "2026-11-19T12:00:00.000Z";

export const notionListedTools: ListedMcpToolInput[] = [
  {
    name: "notion-search",
    title: "Search",
    description: "Search the workspace",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        limit: { type: "integer", minimum: 1 },
        filter: { type: "string", enum: ["page", "database"] },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              url: { type: ["string", "null"] },
            },
            required: ["id", "title"],
          },
        },
        hasMore: { type: "boolean" },
      },
      required: ["results"],
    },
  },
  {
    name: "notion-create-pages",
    description: "Create one or more pages",
    inputSchema: {
      type: "object",
      properties: {
        parent: { $ref: "#/$defs/parent" },
        pages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string" },
            },
            required: ["title"],
          },
        },
      },
      required: ["parent", "pages"],
      $defs: {
        parent: {
          anyOf: [
            {
              type: "object",
              properties: { page_id: { type: "string" } },
              required: ["page_id"],
            },
            {
              type: "object",
              properties: { database_id: { type: "string" } },
              required: ["database_id"],
            },
          ],
        },
      },
    },
  },
];

export const edgeCaseListedTools: ListedMcpToolInput[] = [
  {
    name: "get_item",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  {
    name: "get-item",
    inputSchema: {
      type: "object",
      properties: {
        kind: { const: "item" },
        priority: { enum: [1, 2, "high", null] },
        nullableCount: { type: "number", nullable: true },
        tags: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        meta: {
          type: "object",
          patternProperties: { "^x-": { type: "string" } },
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "walk tree",
    description: 'Walks a "tree" of nodes',
    inputSchema: {
      type: "object",
      properties: { root: { $ref: "#/definitions/node" } },
      required: ["root"],
      definitions: {
        node: {
          type: "object",
          properties: {
            name: { type: "string" },
            children: { type: "array", items: { $ref: "#/definitions/node" } },
          },
          required: ["name"],
        },
      },
    },
    outputSchema: {
      oneOf: [
        { type: "object", properties: { ok: { const: true } } },
        { type: "string" },
      ],
    },
  },
];
