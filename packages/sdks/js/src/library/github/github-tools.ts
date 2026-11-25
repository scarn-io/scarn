// HAND-WRITTEN in `scarn mcp pull` format, not pulled: the input schema comes
// from docs/research/github-remote-mcp.md §3 (the live `tools/list` of
// https://api.githubcopilot.com/mcp/x/issues/readonly). Replace it with a real
// `scarn mcp pull` once there is a token to pull with.
// Tool names and schemas only; the library binds it with `withTools(...)`.
import { mcpTool, mcpToolCatalog } from "../../definitions/mcp-tools/catalog";
import { z } from "zod";

export const githubTools = mcpToolCatalog({
  source: { server: "github" },
  tools: {
    listIssues: mcpTool({
      name: "list_issues",
      description:
        "List issues in a GitHub repository. For pagination, use the 'endCursor' from the previous response's 'pageInfo' in the 'after' parameter.",
      input: z.object({
        owner: z.string(),
        repo: z.string(),
        state: z.optional(z.enum(["OPEN", "CLOSED"])),
        labels: z.optional(z.array(z.string())),
        orderBy: z.optional(z.enum(["CREATED_AT", "UPDATED_AT", "COMMENTS"])),
        direction: z.optional(z.enum(["ASC", "DESC"])),
        since: z.optional(z.string()),
        perPage: z.optional(z.number()),
        after: z.optional(z.string()),
      }),
      inputJsonSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner" },
          repo: { type: "string", description: "Repository name" },
          state: { type: "string", enum: ["OPEN", "CLOSED"] },
          labels: { type: "array", items: { type: "string" } },
          orderBy: {
            type: "string",
            enum: ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
          },
          direction: { type: "string", enum: ["ASC", "DESC"] },
          since: {
            type: "string",
            description: "Filter by date (ISO 8601 timestamp)",
          },
          perPage: { type: "number", minimum: 1, maximum: 100 },
          after: { type: "string", description: "Cursor for pagination" },
        },
        required: ["owner", "repo"],
      },
    }),
  },
});
