import { describe, expect, test } from "bun:test";
import {
  createFakeMcpClients,
  Env,
  McpOutputInvalidError,
  McpUnavailableError,
} from "../src/definitions/steps";
import {
  createGitHubMcpSourceClient,
  GITHUB_PAGE_SIZE,
  githubServerFor,
} from "../src/library/github/mcp-adapter";

async function rejection(promise: Promise<object>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

const { handle } = githubServerFor({
  type: "apiKey",
  token: Env.secret("GITHUB_TOKEN"),
});

type Args = Record<string, unknown>;

function issue(n: number, updated = "2026-11-24T11:00:00Z") {
  return {
    number: n,
    title: `Issue ${String(n)}`,
    body: "",
    state: "OPEN",
    user: { login: "alice" },
    labels: [],
    assignees: [],
    comments: 0,
    created_at: updated,
    updated_at: updated,
  };
}

function page(
  issues: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor?: string },
) {
  return { issues, totalCount: issues.length, pageInfo };
}

/** `list_issues` answers in text content; the default fake does too. */
function clientWith(respond: (args: Args) => unknown) {
  const calls: Args[] = [];
  const mcp = createFakeMcpClients(
    { github: handle },
    {
      github: {
        listIssues: (args) => {
          calls.push(args);
          return {
            content: [{ type: "text", text: JSON.stringify(respond(args)) }],
            structuredContent: null,
          };
        },
      },
    },
  );
  return { source: createGitHubMcpSourceClient({ mcp: mcp.github }), calls };
}

const request = {
  repo: "acme/repo",
  since: "2026-11-24T10:30:00.000Z",
  cursor: null,
};

describe("GitHub MCP adapter", () => {
  test("builds the list arguments: owner, repo, UPDATED_AT ascending, since, page size", async () => {
    const { source, calls } = clientWith(() =>
      page([issue(1)], { hasNextPage: false }),
    );
    const result = await source.listIssuesUpdatedSince(request);
    expect(result).toEqual({ issues: [issue(1)], next: null });
    expect(calls).toEqual([
      {
        owner: "acme",
        repo: "repo",
        orderBy: "UPDATED_AT",
        direction: "ASC",
        since: "2026-11-24T10:30:00.000Z",
        perPage: GITHUB_PAGE_SIZE,
      },
    ]);
  });

  test("the next page passes endCursor as after, with the same since", async () => {
    const { source, calls } = clientWith((args) =>
      args["after"] === undefined
        ? page([issue(1)], { hasNextPage: true, endCursor: "cur-2" })
        : page([issue(2)], { hasNextPage: false }),
    );
    const first = await source.listIssuesUpdatedSince(request);
    expect(first.next).toBe("cur-2");
    const second = await source.listIssuesUpdatedSince({
      ...request,
      cursor: first.next,
    });
    expect(second).toEqual({ issues: [issue(2)], next: null });
    expect(calls[1]).toMatchObject({
      after: "cur-2",
      since: "2026-11-24T10:30:00.000Z",
    });
  });

  test("reads structuredContent when the server sends it", async () => {
    const mcp = createFakeMcpClients(
      { github: handle },
      {
        github: {
          listIssues: () => ({
            content: [],
            structuredContent: page([issue(3)], { hasNextPage: false }),
          }),
        },
      },
    );
    const source = createGitHubMcpSourceClient({ mcp: mcp.github });
    expect((await source.listIssuesUpdatedSince(request)).issues).toEqual([
      issue(3),
    ]);
  });

  test.each([
    ["more pages but no cursor", page([issue(1)], { hasNextPage: true })],
    [
      "an empty page that claims more",
      page([], { hasNextPage: true, endCursor: "x" }),
    ],
    [
      "an issue without updated_at",
      page([{ number: 1, title: "x", state: "OPEN", created_at: "x" }], {
        hasNextPage: false,
      }),
    ],
    ["no issues array", { items: [] }],
    ["CSV instead of JSON", "number,title\n1,x"],
  ])("%s is McpOutputInvalid", async (_name, output) => {
    const { source } = clientWith(() => output);
    expect(
      await rejection(source.listIssuesUpdatedSince(request)),
    ).toBeInstanceOf(McpOutputInvalidError);
  });

  test("a missing tool explains the token's scopes", async () => {
    const mcp = createFakeMcpClients(
      { github: handle },
      {
        github: {
          listIssues: () => {
            throw new McpUnavailableError(
              "MCP tool github.list_issues was not found.",
              "tool_not_found",
              "unknown tool",
            );
          },
        },
      },
    );
    const source = createGitHubMcpSourceClient({ mcp: mcp.github });
    expect(
      (await rejection(source.listIssuesUpdatedSince(request))).message,
    ).toMatch(/Issues: read/);
  });
});
