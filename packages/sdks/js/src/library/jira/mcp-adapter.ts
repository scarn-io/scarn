/**
 * The MCP adapter of `JiraSourceClient`: Atlassian's remote MCP server
 * (`/v2/mcp`), for both auth types. It builds the server definition from
 * `auth`, and searches with `searchJiraIssuesUsingJql`, validating every
 * result with zod so a changed output fails with `Scarn.McpOutputInvalid`
 * instead of saving bad data.
 */
import { prettifyError, z } from "zod";
import { defineMcp } from "../../definitions/steps/define-mcp";
import { Env, type EnvEntry } from "../../definitions/steps/env";
import type { McpClient } from "../../definitions/steps/code-step-mcp-client";
import {
  McpOutputInvalidError,
  McpUnavailableError,
} from "../../definitions/steps/mcp-errors";
import { atlassianTools } from "./atlassian-tools";
import { DEFAULT_ATLASSIAN_CONNECTION, type JiraAuth } from "./auth";
import { jiraIssueSchema, type JiraIssue } from "./map-jira-issue";
import type {
  JiraSearchCursor,
  JiraSearchPage,
  JiraSourceClient,
} from "./source-client";

export const ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v2/mcp";
/** The step's server key for the Atlassian MCP server. */
export const ATLASSIAN_MCP_KEY = "atlassian";
export const JIRA_EMAIL_VAR = "JIRA_EMAIL";
export const JIRA_API_TOKEN_VAR = "JIRA_API_TOKEN";
export const JIRA_PAGE_SIZE = 100;

/** The fields the mapper reads; custom fields need names MCP can't list. */
export const JIRA_SEARCH_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "labels",
  "assignee",
  "reporter",
  "created",
  "updated",
];

function atlassianServer(
  headers?: Record<string, string>,
  vars?: Record<string, EnvEntry>,
) {
  return defineMcp({
    type: "remote",
    name: ATLASSIAN_MCP_KEY,
    url: ATLASSIAN_MCP_URL,
    ...(headers ? { headers } : {}),
    ...(vars && Object.keys(vars).length > 0 ? { vars } : {}),
  }).withTools(atlassianTools);
}

export type AtlassianMcpHandle = ReturnType<typeof atlassianServer>;

export type AtlassianServer = {
  readonly handle: AtlassianMcpHandle;
};

/**
 * The variable a `{basic:…}` half reads, and the server variable to declare
 * for it, if any: a project secret or a literal email. A worker variable
 * (`Env.inherit`) is read by the header directly. Either way it stays on
 * the worker side of the MCP bridge, out of the step's container.
 */
function credentialVar(
  fallbackName: string,
  ref: string | EnvEntry,
): { name: string; declare?: EnvEntry } {
  if (typeof ref === "string") {
    return { name: fallbackName, declare: Env.value({ value: ref }) };
  }
  if (ref.kind === "inherit") return { name: ref.from ?? fallbackName };
  return { name: fallbackName, declare: ref };
}

/** The Atlassian MCP server for `auth`, with the variables its header reads. */
export function atlassianServerFor(auth: JiraAuth): AtlassianServer {
  if (auth.type === "oauth") {
    return {
      handle: defineMcp({
        type: "remote",
        name: ATLASSIAN_MCP_KEY,
        url: ATLASSIAN_MCP_URL,
        auth: { connection: auth.connection ?? DEFAULT_ATLASSIAN_CONNECTION },
      }).withTools(atlassianTools),
    };
  }
  const email = credentialVar(JIRA_EMAIL_VAR, auth.email);
  const token = credentialVar(JIRA_API_TOKEN_VAR, auth.token);
  if (email.name === token.name) {
    throw new Error(
      `auth: email and token both read the variable ${email.name}; give them different names.`,
    );
  }
  const vars: Record<string, EnvEntry> = {};
  if (email.declare) vars[email.name] = email.declare;
  if (token.declare) vars[token.name] = token.declare;
  return {
    handle: atlassianServer(
      { Authorization: `Basic {basic:${email.name}:${token.name}}` },
      vars,
    ),
  };
}

/**
 * `{ data: { issues, isLast?, nextPageToken? } }`, as the live server
 * returned it in Nov 2026 (it used to be `{ issues: { nodes, pageInfo } }`).
 */
const searchOutputSchema = z.object({
  data: z.object({
    issues: z.array(
      jiraIssueSchema.extend({
        fields: z.looseObject({ summary: z.string(), updated: z.string() }),
      }),
    ),
    isLast: z.boolean().nullish(),
    nextPageToken: z.string().nullish(),
  }),
});
type SearchOutput = z.infer<typeof searchOutputSchema>;

/**
 * A cursor is either the server's page token, or, after a short page, a
 * restart from the newest `updated` seen (see `nextCursor`).
 */
const cursorSchema = z.union([
  z.object({ token: z.string() }),
  z.object({ since: z.iso.datetime({ offset: true }) }),
]);
type Cursor = z.infer<typeof cursorSchema>;

function readCursor(cursor: JiraSearchCursor | null): Cursor | null {
  if (cursor === null) return null;
  const parsed = cursorSchema.safeParse(JSON.parse(cursor));
  if (!parsed.success) throw new Error(`Invalid Jira search cursor: ${cursor}`);
  return parsed.data;
}

/** `site`'s host, which `cloudId` accepts in place of the cloud ID. */
export function cloudIdOf(site: string): string {
  return new URL(site).host;
}

/**
 * JQL for `projectKey`'s issues updated at or after `since`, oldest first.
 * JQL reads absolute dates in the account's timezone, which MCP can't
 * reliably tell us, so `since` is written relative to now (`"-90m"`),
 * rounded down to a whole minute earlier; the poller's overlap absorbs it.
 */
export function buildJiraSearchJql(
  projectKey: string,
  since: string,
  now: Date,
): string {
  const minutes = Math.max(
    1,
    Math.ceil((now.getTime() - Date.parse(since)) / 60_000),
  );
  return `project = "${projectKey}" AND updated >= "-${String(minutes)}m" ORDER BY updated ASC, key ASC`;
}

const label = `MCP tool ${ATLASSIAN_MCP_KEY}.searchJiraIssuesUsingJql`;

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
function parseOutput(value: unknown): SearchOutput {
  if (value === undefined) {
    throw new McpOutputInvalidError(
      `${label} returned neither structuredContent nor JSON text.`,
    );
  }
  const parsed = searchOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpOutputInvalidError(
      `${label}: the result doesn't match the expected search output:\n${prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function newestUpdated(issues: readonly JiraIssue[]): string {
  let newest = Number.NEGATIVE_INFINITY;
  for (const issue of issues) {
    newest = Math.max(newest, Date.parse(issue.fields["updated"] as string));
  }
  return new Date(newest).toISOString();
}

/**
 * The next page's cursor. There is a next page unless `isLast` is true or
 * the server sent no `nextPageToken`; `isLast: false` without a token is an
 * error.
 *
 * Atlassian's paging has silently skipped issues (a page of fewer issues
 * than asked for while the token advanced by the full page). A short page
 * that claims more is therefore not trusted: the next page restarts from the
 * newest `updated` it saw, which can't skip anything because results are in
 * ascending `updated` order. A restart that makes no progress is an error.
 */
function nextCursor(output: SearchOutput, restartedFrom: string | null) {
  const { issues: nodes, isLast, nextPageToken } = output.data;
  if (isLast === true) return null;
  if (!nextPageToken) {
    if (isLast === false) {
      throw new McpOutputInvalidError(
        `${label}: isLast is false but there is no nextPageToken.`,
      );
    }
    return null;
  }
  if (nodes.length >= JIRA_PAGE_SIZE) {
    return JSON.stringify({ token: nextPageToken });
  }
  if (nodes.length === 0) {
    throw new McpOutputInvalidError(
      `${label}: an empty page claims there are more issues.`,
    );
  }
  const since = newestUpdated(nodes);
  if (
    restartedFrom !== null &&
    Date.parse(since) <= Date.parse(restartedFrom)
  ) {
    throw new McpOutputInvalidError(
      `${label}: paging made no progress past ${since}; Jira returned short pages for issues updated in the same minute.`,
    );
  }
  return JSON.stringify({ since });
}

// eslint-disable-next-line local/no-unknown-parameter-type -- rethrows caught errors
function withToolHint(error: unknown): unknown {
  if (
    error instanceof McpUnavailableError &&
    error.reason === "tool_not_found"
  ) {
    return new McpUnavailableError(
      `${error.message} The Atlassian MCP server hides Jira tools from an API token without the read:jira:agent-interface and search:jira:agent-interface scopes, or when the org admin hasn't allowed API-token auth.`,
      error.reason,
      error.detail,
    );
  }
  return error;
}

/** A `JiraSourceClient` over the step's Atlassian MCP client. */
export function createJiraMcpSourceClient(options: {
  readonly mcp: McpClient<AtlassianMcpHandle>;
  readonly site: string;
  readonly now?: () => Date;
}): JiraSourceClient {
  const cloudId = cloudIdOf(options.site);
  const now = options.now ?? (() => new Date());
  return {
    searchIssuesUpdatedSince: async ({ projectKey, since, cursor }) => {
      const state = readCursor(cursor);
      const restartedFrom =
        state !== null && "since" in state ? state.since : null;
      const args = {
        cloudId,
        jql: buildJiraSearchJql(projectKey, restartedFrom ?? since, now()),
        fields: JIRA_SEARCH_FIELDS,
        maxResults: JIRA_PAGE_SIZE,
        responseContentFormat: "markdown" as const,
        searchResultMode: "issues" as const,
        view: "full" as const,
        ...(state !== null && "token" in state
          ? { nextPageToken: state.token }
          : {}),
      };
      const result = await options.mcp
        .searchJiraIssuesUsingJql(args)
        // eslint-disable-next-line local/no-unknown-parameter-type -- rethrows caught errors
        .catch((error: unknown) => {
          throw withToolHint(error);
        });
      const output = parseOutput(rawOutput(result));
      const page: JiraSearchPage = {
        issues: output.data.issues,
        next: nextCursor(output, restartedFrom),
      };
      return page;
    },
  };
}
