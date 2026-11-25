/**
 * The MCP adapter of `GitHubSourceClient`: GitHub's remote MCP server, issues
 * toolset, read-only. It builds the server definition from `auth`, and lists
 * issues with `list_issues` (`UPDATED_AT` ascending, `since`, cursor paging),
 * validating every result with zod so a changed output fails with
 * `Scarn.McpOutputInvalid` instead of saving bad data.
 */
import { prettifyError, z } from "zod";
import { defineMcp } from "../../definitions/steps/define-mcp";
import type { EnvEntry } from "../../definitions/steps/env";
import type { McpClient } from "../../definitions/steps/code-step-mcp-client";
import {
  McpOutputInvalidError,
  McpUnavailableError,
} from "../../definitions/steps/mcp-errors";
import type { GitHubAuth } from "./auth";
import { githubTools } from "./github-tools";
import { gitHubIssueSchema } from "./map-github-issue";
import type { GitHubListPage, GitHubSourceClient } from "./source-client";

/** Issues toolset, read-only. Not `X-MCP-Insiders`: it turns lists into CSV. */
export const GITHUB_MCP_URL =
  "https://api.githubcopilot.com/mcp/x/issues/readonly";
/** The step's server key for GitHub's MCP server. */
export const GITHUB_MCP_KEY = "github";
export const GITHUB_TOKEN_VAR = "GITHUB_TOKEN";
export const GITHUB_PAGE_SIZE = 100;

function githubServer(tokenVar: string, vars?: Record<string, EnvEntry>) {
  return defineMcp({
    type: "remote",
    name: GITHUB_MCP_KEY,
    url: GITHUB_MCP_URL,
    headers: { Authorization: `Bearer {env:${tokenVar}}` },
    ...(vars ? { vars } : {}),
  }).withTools(githubTools);
}

export type GitHubMcpHandle = ReturnType<typeof githubServer>;

export type GitHubServer = {
  readonly handle: GitHubMcpHandle;
};

/**
 * GitHub's MCP server for `auth`. The token is read by the server's header,
 * from a worker variable directly or a project secret declared on the
 * server, so it stays on the worker side of the MCP bridge, out of the
 * step's container.
 */
export function githubServerFor(auth: GitHubAuth): GitHubServer {
  const { token } = auth;
  if (token.kind === "inherit") {
    return { handle: githubServer(token.from ?? GITHUB_TOKEN_VAR) };
  }
  return {
    handle: githubServer(GITHUB_TOKEN_VAR, { [GITHUB_TOKEN_VAR]: token }),
  };
}

const listOutputSchema = z.object({
  issues: z.array(gitHubIssueSchema),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullish(),
  }),
  totalCount: z.number().nullish(),
});
type ListOutput = z.infer<typeof listOutputSchema>;

const label = `MCP tool ${GITHUB_MCP_KEY}.list_issues`;

/** `structuredContent`, or the JSON of the first text block when there is none. */
function rawOutput(result: {
  structuredContent: Record<string, unknown> | null;
  content: readonly { type: string; text?: unknown }[];
}): unknown {
  if (result.structuredContent !== null) return result.structuredContent;
  const text = result.content.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line local/no-unknown-parameter-type -- parses raw MCP output
function parseOutput(value: unknown): ListOutput {
  if (value === undefined) {
    throw new McpOutputInvalidError(
      `${label} returned neither structuredContent nor JSON text.`,
    );
  }
  const parsed = listOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpOutputInvalidError(
      `${label}: the result doesn't match the expected list output:\n${prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function nextCursor(output: ListOutput): string | null {
  const { pageInfo, issues } = output;
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor) {
    throw new McpOutputInvalidError(
      `${label}: pageInfo.hasNextPage is true but there is no endCursor.`,
    );
  }
  if (issues.length === 0) {
    throw new McpOutputInvalidError(
      `${label}: an empty page claims there are more issues.`,
    );
  }
  return pageInfo.endCursor;
}

/** `owner/repo` split in two. */
export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

// eslint-disable-next-line local/no-unknown-parameter-type -- rethrows caught errors
function withToolHint(error: unknown): unknown {
  if (
    error instanceof McpUnavailableError &&
    error.reason === "tool_not_found"
  ) {
    return new McpUnavailableError(
      `${error.message} GitHub's MCP server hides list_issues from a classic token without the repo (or public_repo) scope; a fine-grained token needs Issues: read on the repo.`,
      error.reason,
      error.detail,
    );
  }
  return error;
}

/** A `GitHubSourceClient` over the step's GitHub MCP client. */
export function createGitHubMcpSourceClient(options: {
  readonly mcp: McpClient<GitHubMcpHandle>;
}): GitHubSourceClient {
  return {
    listIssuesUpdatedSince: async ({ repo, since, cursor }) => {
      const { owner, name } = splitRepo(repo);
      const args = {
        owner,
        repo: name,
        orderBy: "UPDATED_AT" as const,
        direction: "ASC" as const,
        since,
        perPage: GITHUB_PAGE_SIZE,
        ...(cursor !== null ? { after: cursor } : {}),
      };
      const result = await options.mcp
        .listIssues(args)
        // eslint-disable-next-line local/no-unknown-parameter-type -- rethrows caught errors
        .catch((error: unknown) => {
          throw withToolHint(error);
        });
      const output = parseOutput(rawOutput(result));
      const page: GitHubListPage = {
        issues: output.issues,
        next: nextCursor(output),
      };
      return page;
    },
  };
}
