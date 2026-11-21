/** A shared tool catalog and handle for the MCP tool step tests. */
import { z } from "zod";
import { defineMcp, mcpTool, mcpToolCatalog } from "../src/definitions/steps";

export const searchInputJsonSchema = {
  type: "object",
  properties: { query: { type: "string" }, limit: { type: "number" } },
  required: ["query"],
};

export const searchOutputJsonSchema = {
  type: "object",
  properties: { results: { type: "array" } },
  required: ["results"],
};

export const notionTools = mcpToolCatalog({
  source: { server: "notion", lockHash: "sha256:abc" },
  tools: {
    search: mcpTool({
      name: "notion-search",
      title: "Search",
      description: "Search the workspace",
      input: z.object({ query: z.string(), limit: z.number().optional() }),
      inputJsonSchema: searchInputJsonSchema,
      output: z.object({ results: z.array(z.object({ title: z.string() })) }),
      outputJsonSchema: searchOutputJsonSchema,
    }),
    createPages: mcpTool({
      name: "notion_create_pages",
      input: z.object({
        parent: z.object({ page_id: z.string() }),
        pages: z.array(z.object({ title: z.string(), content: z.string() })),
      }),
    }),
  },
});

export const notion = defineMcp({
  type: "ref",
  name: "notion",
  auth: { connection: "notion" },
}).withTools(notionTools);
