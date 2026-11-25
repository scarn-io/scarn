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
import { mapJiraIssue } from "../src/library/jira/map-jira-issue";

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
  issues: unknown[],
  paging: { isLast?: boolean; nextPageToken?: string } = {},
) {
  return { data: { issues, ...paging } };
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
  test("builds the search arguments: site as cloudId, relative JQL, markdown, full view, page size", async () => {
    const { source, calls } = clientWith(() =>
      page([issue(1)], { isLast: true }),
    );
    const result = await source.searchIssuesUpdatedSince(request);
    expect(result).toEqual({ issues: [issue(1)], next: null });
    expect(calls).toEqual([
      {
        cloudId: "acme.atlassian.net",
        jql: 'project = "ABC" AND updated >= "-90m" ORDER BY updated ASC, key ASC',
        fields: expect.arrayContaining(["summary", "description", "updated"]),
        maxResults: JIRA_PAGE_SIZE,
        responseContentFormat: "markdown",
        searchResultMode: "issues",
        view: "full",
      },
    ]);
  });

  test("a page without isLast or nextPageToken is the last", async () => {
    const { source } = clientWith(() => page([issue(1)]));
    expect(await source.searchIssuesUpdatedSince(request)).toEqual({
      issues: [issue(1)],
      next: null,
    });
  });

  test("an issue in the live server's shape maps to a work item", async () => {
    const live = {
      id: "10001",
      key: "ABC-1",
      fields: {
        summary: "Checkout fails",
        issuetype: { id: "10007", name: "Story", hierarchyLevel: 0 },
        created: "2026-10-30T15:21:51.602-0500",
        description: "**SUMMARY:** checkout fails.\n\n",
        reporter: { accountId: "a-1", displayName: "Reporter One" },
        assignee: { accountId: "a-2", displayName: "Assignee Two" },
        priority: { name: "Medium", id: "3" },
        updated: "2026-11-23T17:28:12.596-0600",
        status: {
          name: "Done",
          id: "5",
          statusCategory: { key: "done", name: "Done" },
        },
        labels: ["Ephemeral"],
      },
    };
    const { source } = clientWith(() => page([live], { isLast: true }));
    const [found] = (await source.searchIssuesUpdatedSince(request)).issues;
    if (!found) throw new Error("expected an issue");
    expect(
      mapJiraIssue(found, { site: "https://acme.atlassian.net" }),
    ).toMatchObject({
      platformKey: "ABC-1",
      description: "**SUMMARY:** checkout fails.",
      sourceCreatedAt: "2026-10-30T20:21:51.602Z",
      sourceUpdatedAt: "2026-11-23T23:28:12.596Z",
      state: "closed",
      fields: {
        status: "Done",
        priority: "Medium",
        issueType: "Story",
        assignee: "Assignee Two",
        reporter: "Reporter One",
      },
    });
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
        ? page(full, { isLast: false, nextPageToken: "tok-2" })
        : page([issue(200)], { isLast: true }),
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
            { isLast: false, nextPageToken: "skips-ahead" },
          )
        : page([], { isLast: true }),
    );
    const first = await source.searchIssuesUpdatedSince(request);
    await source.searchIssuesUpdatedSince({ ...request, cursor: first.next });
    expect(calls[1]).not.toHaveProperty("nextPageToken");
    expect(calls[1]?.["jql"]).toContain('updated >= "-20m"');
  });

  test("a restart that makes no progress fails", async () => {
    const stuck = page([issue(1, "2026-11-24T11:40:00.000+0000")], {
      isLast: false,
      nextPageToken: "x",
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
    ["isLast false without a token", page([issue(1)], { isLast: false })],
    [
      "an empty page that claims more",
      page([], { isLast: false, nextPageToken: "x" }),
    ],
    [
      "an issue without updated",
      page([{ id: "1", key: "ABC-1", fields: { summary: "x" } }], {
        isLast: true,
      }),
    ],
    ["no data object", { issues: [] }],
    [
      "the old issues.nodes shape",
      { issues: { nodes: [issue(1)], pageInfo: { hasNextPage: false } } },
    ],
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
                text: JSON.stringify(page([issue(1)], { isLast: true })),
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
