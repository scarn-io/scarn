import { describe, expect, test } from "bun:test";
import {
  createFakeMcpClients,
  McpOutputInvalidError,
  McpUnavailableError,
} from "../src/definitions/steps";
import {
  atlassianServerFor,
  buildJiraSearchJql,
  createJiraMcpSourceClient,
  JIRA_PAGE_SIZE,
} from "../src/library/jira/mcp-adapter";

async function rejection(promise: Promise<object>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

const { handle } = atlassianServerFor({ type: "oauth" });
const now = new Date("2026-11-24T12:00:00.000Z");

type Args = Record<string, unknown>;

function issue(n: number, updated = "2026-11-24T11:00:00.000+0000") {
  return {
    id: String(10_000 + n),
    key: `ABC-${String(n)}`,
    fields: { summary: `Issue ${String(n)}`, updated },
  };
}

function page(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor?: string },
  extra: Record<string, unknown> = {},
) {
  return { issues: { nodes, pageInfo, ...extra } };
}

function clientWith(respond: (args: Args) => unknown) {
  const calls: Args[] = [];
  const mcp = createFakeMcpClients(
    { atlassian: handle },
    {
      atlassian: {
        searchJiraIssuesUsingJql: (args) => {
          calls.push(args);
          return {
            content: [],
            structuredContent: respond(args) as Record<string, unknown>,
          };
        },
      },
    },
  );
  const source = createJiraMcpSourceClient({
    mcp: mcp.atlassian,
    site: "https://acme.atlassian.net/",
    now: () => now,
  });
  return { source, calls };
}

const request = {
  projectKey: "ABC",
  since: "2026-11-24T10:30:00.000Z",
  cursor: null,
};

describe("Jira MCP adapter", () => {
  test("builds the search arguments: site as cloudId, relative JQL, adf, page size", async () => {
    const { source, calls } = clientWith(() =>
      page([issue(1)], { hasNextPage: false }),
    );
    const result = await source.searchIssuesUpdatedSince(request);
    expect(result).toEqual({ issues: [issue(1)], next: null });
    expect(calls).toEqual([
      {
        cloudId: "acme.atlassian.net",
        jql: 'project = "ABC" AND updated >= "-90m" ORDER BY updated ASC, key ASC',
        fields: expect.arrayContaining(["summary", "description", "updated"]),
        maxResults: JIRA_PAGE_SIZE,
        responseContentFormat: "adf",
        searchResultMode: "issues",
      },
    ]);
  });

  test("relative minutes round up, so the window never starts late", () => {
    expect(buildJiraSearchJql("ABC", "2026-11-24T11:58:30.000Z", now)).toBe(
      'project = "ABC" AND updated >= "-2m" ORDER BY updated ASC, key ASC',
    );
    expect(
      buildJiraSearchJql("ABC", "2026-11-24T12:00:30.000Z", now),
    ).toContain('"-1m"');
  });

  test("a full page passes the server's token back", async () => {
    const full = Array.from({ length: JIRA_PAGE_SIZE }, (_, n) => issue(n));
    const { source, calls } = clientWith((args) =>
      args["nextPageToken"] === undefined
        ? page(full, { hasNextPage: true, endCursor: "tok-2" })
        : page([issue(200)], { hasNextPage: false }),
    );
    const first = await source.searchIssuesUpdatedSince(request);
    expect(first.next).not.toBeNull();
    const second = await source.searchIssuesUpdatedSince({
      ...request,
      cursor: first.next,
    });
    expect(second).toEqual({ issues: [issue(200)], next: null });
    expect(calls[1]).toMatchObject({ nextPageToken: "tok-2" });
    expect(calls[1]?.["jql"]).toBe(calls[0]?.["jql"]);
  });

  test("a short page that claims more restarts from its newest updated, without the token", async () => {
    const { source, calls } = clientWith(() =>
      calls.length === 1
        ? page(
            [
              issue(1, "2026-11-24T11:00:00.000+0000"),
              issue(2, "2026-11-24T11:40:00.000+0000"),
            ],
            { hasNextPage: true, endCursor: "skips-ahead" },
          )
        : page([], { hasNextPage: false }),
    );
    const first = await source.searchIssuesUpdatedSince(request);
    await source.searchIssuesUpdatedSince({ ...request, cursor: first.next });
    expect(calls[1]).not.toHaveProperty("nextPageToken");
    expect(calls[1]?.["jql"]).toContain('updated >= "-20m"');
  });

  test("a restart that makes no progress fails", async () => {
    const stuck = page([issue(1, "2026-11-24T11:40:00.000+0000")], {
      hasNextPage: true,
      endCursor: "x",
    });
    const { source } = clientWith(() => stuck);
    const first = await source.searchIssuesUpdatedSince(request);
    expect(
      await rejection(
        source.searchIssuesUpdatedSince({ ...request, cursor: first.next }),
      ),
    ).toBeInstanceOf(McpOutputInvalidError);
  });

  test.each([
    [
      "no more pages but issues remain",
      page([issue(1)], { hasNextPage: false }, { remainingCount: 3 }),
    ],
    ["more pages but no cursor", page([issue(1)], { hasNextPage: true })],
    [
      "an empty page that claims more",
      page([], { hasNextPage: true, endCursor: "x" }),
    ],
    [
      "a node without updated",
      page([{ id: "1", key: "ABC-1", fields: { summary: "x" } }], {
        hasNextPage: false,
      }),
    ],
    ["no issues object", { results: [] }],
  ])("%s is McpOutputInvalid", async (_name, output) => {
    const { source } = clientWith(() => output);
    expect(
      await rejection(source.searchIssuesUpdatedSince(request)),
    ).toBeInstanceOf(McpOutputInvalidError);
  });

  test("falls back to JSON in the first text block", async () => {
    const mcp = createFakeMcpClients(
      { atlassian: handle },
      {
        atlassian: {
          searchJiraIssuesUsingJql: () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify(page([issue(1)], { hasNextPage: false })),
              },
            ],
            structuredContent: null,
          }),
        },
      },
    );
    const source = createJiraMcpSourceClient({
      mcp: mcp.atlassian,
      site: "https://acme.atlassian.net",
    });
    expect((await source.searchIssuesUpdatedSince(request)).issues).toEqual([
      issue(1),
    ]);
  });

  test("a missing tool explains the API-token scopes", async () => {
    const mcp = createFakeMcpClients(
      { atlassian: handle },
      {
        atlassian: {
          searchJiraIssuesUsingJql: () => {
            throw new McpUnavailableError(
              "MCP tool atlassian.searchJiraIssuesUsingJql was not found.",
              "tool_not_found",
              "unknown tool",
            );
          },
        },
      },
    );
    const source = createJiraMcpSourceClient({
      mcp: mcp.atlassian,
      site: "https://acme.atlassian.net",
    });
    expect(
      (await rejection(source.searchIssuesUpdatedSince(request))).message,
    ).toMatch(/search:jira:agent-interface/);
  });
});
