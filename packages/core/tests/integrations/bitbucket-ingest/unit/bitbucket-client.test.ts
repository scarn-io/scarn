import { describe, expect, test } from "bun:test";
import { CoreError } from "@/lib/errors";
import {
  BitbucketApiError,
  buildBitbucketIssuesQuery,
  createBitbucketClient,
} from "@/integrations/bitbucket-ingest/infra/bitbucket-client";

const EMAIL = "dev@acme.test";
const TOKEN = "ATATT-secret-token-value";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;

type Recorded = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
};
type Reply = { status: number; body: object };

const fakeFetch = (replies: Reply[]) => {
  const requests: Recorded[] = [];
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const reply = replies[requests.length - 1] ?? replies.at(-1);
    if (!reply) throw new Error("no reply configured");
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
};

const client = (replies: Reply[], secretName: string | null = null) => {
  const fake = fakeFetch(replies);
  return {
    ...fake,
    client: createBitbucketClient({
      email: EMAIL,
      apiToken: TOKEN,
      secretName,
      fetchImpl: fake.fetchImpl,
    }),
  };
};

const caught = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected an error");
};

const issue = (id: number) => ({
  id,
  title: `Issue ${String(id)}`,
  state: "open",
  created_on: "2026-01-01T00:00:00Z",
  updated_on: "2026-01-02T00:00:00Z",
});

describe("getRepository", () => {
  test("reads the repo with email:token basic auth", async () => {
    const { client: bb, requests } = client([
      {
        status: 200,
        body: {
          full_name: "Team/Api",
          slug: "api",
          has_issues: true,
          workspace: { slug: "team" },
        },
      },
    ]);

    const repo = await bb.getRepository("team", "api");

    expect(repo).toEqual({
      workspace: "team",
      slug: "api",
      fullName: "Team/Api",
      hasIssues: true,
    });
    expect(requests[0]?.url).toBe(
      "https://api.bitbucket.org/2.0/repositories/team/api",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(EXPECTED_AUTH);
  });

  test("a 401 is BITBUCKET_API_TOKEN_REJECTED naming the saved key, never the token or body", async () => {
    const { client: bb } = client(
      [{ status: 401, body: { error: { message: "provider detail" } } }],
      "Work Bitbucket",
    );

    const error = await caught(() => bb.getRepository("team", "api"));

    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("BITBUCKET_API_TOKEN_REJECTED");
    expect(error.message).toContain("Work Bitbucket");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(EMAIL);
    expect(error.message).not.toContain("provider detail");
  });

  test.each([403, 404])(
    "a %d is BITBUCKET_REPO_NOT_ACCESSIBLE",
    async (status) => {
      const { client: bb } = client([{ status, body: {} }]);

      const error = (await caught(() =>
        bb.getRepository("team", "api"),
      )) as CoreError;

      expect(error.code).toBe("BITBUCKET_REPO_NOT_ACCESSIBLE");
      expect(error.status).toBe(422);
      expect(error.message).toContain("team/api");
    },
  );

  test("any other failure is BITBUCKET_REQUEST_FAILED without Bitbucket's body", async () => {
    const { client: bb } = client([
      { status: 500, body: { error: { message: "internal detail" } } },
    ]);

    const error = (await caught(() =>
      bb.getRepository("team", "api"),
    )) as CoreError;

    expect(error.code).toBe("BITBUCKET_REQUEST_FAILED");
    expect(error.message).not.toContain("internal detail");
  });
});

describe("getCurrentUser", () => {
  test("returns the account and maps a 401 to the rejected error", async () => {
    const ok = client([
      {
        status: 200,
        body: { account_id: "a-1", display_name: "Dev", username: "dev" },
      },
    ]);
    expect(await ok.client.getCurrentUser()).toEqual({
      accountId: "a-1",
      displayName: "Dev",
      username: "dev",
    });
    expect(ok.requests[0]?.url).toBe("https://api.bitbucket.org/2.0/user");

    const rejected = client([{ status: 401, body: {} }]);
    const error = (await caught(() =>
      rejected.client.getCurrentUser(),
    )) as CoreError;
    expect(error.code).toBe("BITBUCKET_API_TOKEN_REJECTED");
  });
});

describe("listIssues", () => {
  test("filters by updated_on and follows next until it runs out", async () => {
    const next =
      "https://api.bitbucket.org/2.0/repositories/team/api/issues?page=2";
    const { client: bb, requests } = client([
      { status: 200, body: { values: [issue(1), issue(2)], next } },
      { status: 200, body: { values: [issue(3)] } },
    ]);

    const issues = await bb.listIssues("team", "api", {
      updatedSince: "2026-03-01T10:00:00.000Z",
    });

    expect(issues.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(requests).toHaveLength(2);
    const first = new URL(requests[0]?.url ?? "");
    expect(first.pathname).toBe("/2.0/repositories/team/api/issues");
    expect(first.searchParams.get("q")).toBe(
      'updated_on>"2026-03-01T10:00:00.000Z"',
    );
    expect(requests[1]?.url).toBe(next);
    expect(requests[1]?.headers.get("authorization")).toBe(EXPECTED_AUTH);
  });

  test("omits the filter without a since and never follows a next link off the API", async () => {
    const { client: bb, requests } = client([
      {
        status: 200,
        body: { values: [issue(1)], next: "https://evil.test/steal" },
      },
    ]);

    const error = await caught(() =>
      bb.listIssues("team", "api", { updatedSince: null }),
    );

    expect(new URL(requests[0]?.url ?? "").searchParams.has("q")).toBe(false);
    expect(error).toBeInstanceOf(BitbucketApiError);
    expect(requests).toHaveLength(1);
  });

  test("a failed page is a BitbucketApiError with only the status", async () => {
    const { client: bb } = client([
      { status: 401, body: { error: { message: "provider detail" } } },
    ]);

    const error = await caught(() =>
      bb.listIssues("team", "api", { updatedSince: null }),
    );

    expect(error).toBeInstanceOf(BitbucketApiError);
    expect((error as BitbucketApiError).status).toBe(401);
    expect(error.message).not.toContain("provider detail");
    expect(error.message).not.toContain(TOKEN);
  });

  test("buildBitbucketIssuesQuery is empty without a since", () => {
    expect(buildBitbucketIssuesQuery(null)).toBe("");
  });
});

describe("postIssueComment", () => {
  test("posts the raw body and returns the comment id and link", async () => {
    const { client: bb, requests } = client([
      {
        status: 201,
        body: {
          id: 99,
          links: {
            html: {
              href: "https://bitbucket.org/team/api/issues/4#comment-99",
            },
          },
        },
      },
    ]);

    const posted = await bb.postIssueComment("team", "api", 4, "Hello");

    expect(posted).toEqual({
      id: "99",
      url: "https://bitbucket.org/team/api/issues/4#comment-99",
    });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe(
      "https://api.bitbucket.org/2.0/repositories/team/api/issues/4/comments",
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      content: { raw: "Hello" },
    });
  });

  test("a failure is a BitbucketApiError with the status", async () => {
    const { client: bb } = client([{ status: 403, body: {} }]);

    const error = await caught(() =>
      bb.postIssueComment("team", "api", 4, "Hello"),
    );

    expect((error as BitbucketApiError).status).toBe(403);
  });
});
