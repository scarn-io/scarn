// HAND-WRITTEN in `scarn mcp pull` format, not pulled: the input schema comes
// from docs/research/atlassian-remote-mcp.md §3.1 (a mirror of the live
// `tools/list` of https://mcp.atlassian.com/v2/mcp). Replace it with a real
// `scarn mcp pull` once there is a token to pull with.
// Tool names and schemas only; the library binds it with `withTools(...)`.
import { mcpTool, mcpToolCatalog } from "../../definitions/mcp-tools/catalog";
import { z } from "zod";

export const atlassianTools = mcpToolCatalog({
  source: { server: "atlassian" },
  tools: {
    searchJiraIssuesUsingJql: mcpTool({
      name: "searchJiraIssuesUsingJql",
      description: "Search Jira issues using JQL",
      input: z.object({
        cloudId: z.string(),
        jql: z.string(),
        fields: z.optional(z.array(z.string())),
        maxResults: z.optional(z.number()),
        nextPageToken: z.optional(z.string()),
        responseContentFormat: z.optional(z.enum(["markdown", "adf"])),
        searchResultMode: z.optional(z.enum(["issues", "count", "all"])),
      }),
      inputJsonSchema: {
        type: "object",
        properties: {
          cloudId: {
            type: "string",
            description: "Cloud ID (UUID or site URL)",
          },
          jql: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          maxResults: { type: "number", description: "Max (50-100)" },
          nextPageToken: { type: "string" },
          responseContentFormat: {
            type: "string",
            enum: ["markdown", "adf"],
          },
          searchResultMode: {
            type: "string",
            enum: ["issues", "count", "all"],
          },
        },
        required: ["cloudId", "jql"],
      },
    }),
  },
});
