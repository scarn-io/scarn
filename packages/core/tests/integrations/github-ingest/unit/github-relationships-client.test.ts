import { describe, expect, test } from "bun:test";
import {
  fetchIssueRelationshipsBatch,
  GITHUB_RELATIONSHIP_BATCH_SIZE,
  type GitHubIssueRef,
} from "@/integrations/github-ingest/infra/github-relationships-client";
import { GitHubIngestError } from "@/integrations/github-ingest/infra/github-issues-client";

// The repo/codebase idiom asserts rejections via try/catch (the bun
// expect().rejects matcher trips the await-thenable lint rule under the TS
// ESLint config). This captures the thrown error for inspection.
const captureError = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (caught: unknown) {
    return caught;
  }
  throw new Error("Expected the operation to throw, but it resolved");
};

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const graphQLResponse = (
  body: JsonValue,
  init: { status?: number } = {},
): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

type Call = { url: string; query: string };

const toCall = (
  input: string | URL | Request,
  requestInit?: RequestInit,
): Call => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const bodyRaw = requestInit?.body;
  const parsed =
    typeof bodyRaw === "string"
      ? (JSON.parse(bodyRaw) as { query: string })
      : { query: "" };
  return { url, query: parsed.query };
};

describe("fetchIssueRelationshipsBatch", () => {
  test("returns an empty map without calling fetch when refs is empty", async () => {
    const fetchImpl = (() => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const result = await fetchIssueRelationshipsBatch({
      accessToken: "token",
      refs: [],
      fetchImpl,
    });

    expect(result.size).toBe(0);
  });

  test("groups refs from multiple repos into a single aliased query, requesting both parent and blockedBy", async () => {
    const calls: Call[] = [];
    const fetchImpl = ((
      input: string | URL | Request,
      requestInit?: RequestInit,
    ) => {
      calls.push(toCall(input, requestInit));
      return Promise.resolve(
        graphQLResponse({
          data: {
            r0: {
              i0: {
                parent: {
                  number: 9,
                  repository: { owner: { login: "acme" }, name: "repo-a" },
                },
                blockedBy: {
                  nodes: [
                    {
                      number: 5,
                      repository: { owner: { login: "acme" }, name: "repo-a" },
                    },
                  ],
                },
              },
            },
            r1: {
              i0: { parent: null, blockedBy: { nodes: [] } },
            },
          },
        }),
      );
    }) as unknown as typeof fetch;

    const refs: GitHubIssueRef[] = [
      { owner: "acme", repo: "repo-a", number: 1 },
      { owner: "acme", repo: "repo-b", number: 2 },
    ];

    const result = await fetchIssueRelationshipsBatch({
      accessToken: "token",
      refs,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.query).toContain(
      'r0: repository(owner: "acme", name: "repo-a")',
    );
    expect(calls[0]?.query).toContain(
      'r1: repository(owner: "acme", name: "repo-b")',
    );
    expect(calls[0]?.query).toContain("i0: issue(number: 1)");
    expect(calls[0]?.query).toContain("i0: issue(number: 2)");
    expect(calls[0]?.query).toContain("parent {");

    expect(result.get("acme/repo-a#1")).toEqual({
      parent: { owner: "acme", repo: "repo-a", number: 9 },
      blockedBy: [{ owner: "acme", repo: "repo-a", number: 5 }],
    });
    expect(result.get("acme/repo-b#2")).toEqual({
      parent: null,
      blockedBy: [],
    });
  });

  test("splits a single repo's issues across multiple requests once the batch size is exceeded", async () => {
    const totalIssues = GITHUB_RELATIONSHIP_BATCH_SIZE + 10;
    const refs: GitHubIssueRef[] = Array.from(
      { length: totalIssues },
      (_, index) => ({ owner: "acme", repo: "repo", number: index + 1 }),
    );

    const calls: Call[] = [];
    const fetchImpl = ((
      input: string | URL | Request,
      requestInit?: RequestInit,
    ) => {
      const call = toCall(input, requestInit);
      calls.push(call);
      const issueCount = (call.query.match(/issue\(number:/g) ?? []).length;
      const data: Record<string, JsonValue> = {};
      const issueFields: Record<string, JsonValue> = {};
      for (let i = 0; i < issueCount; i++) {
        issueFields[`i${String(i)}`] = {
          parent: null,
          blockedBy: { nodes: [] },
        };
      }
      data["r0"] = issueFields;
      return Promise.resolve(graphQLResponse({ data }));
    }) as unknown as typeof fetch;

    const result = await fetchIssueRelationshipsBatch({
      accessToken: "token",
      refs,
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect((calls[0]?.query.match(/issue\(number:/g) ?? []).length).toBe(
      GITHUB_RELATIONSHIP_BATCH_SIZE,
    );
    expect((calls[1]?.query.match(/issue\(number:/g) ?? []).length).toBe(10);
    expect(result.size).toBe(totalIssues);
    expect(result.get("acme/repo#1")).toEqual({ parent: null, blockedBy: [] });
    expect(result.get(`acme/repo#${String(totalIssues)}`)).toEqual({
      parent: null,
      blockedBy: [],
    });
  });

  test("treats a null aliased field as no relationship data for that issue, not a failure", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        graphQLResponse({
          data: {
            r0: {
              i0: null,
              i1: { parent: null, blockedBy: { nodes: [] } },
            },
          },
        }),
      )) as unknown as typeof fetch;

    const refs: GitHubIssueRef[] = [
      { owner: "acme", repo: "repo", number: 1 },
      { owner: "acme", repo: "repo", number: 2 },
    ];

    const result = await fetchIssueRelationshipsBatch({
      accessToken: "token",
      refs,
      fetchImpl,
    });

    expect(result.get("acme/repo#1")).toEqual({ parent: null, blockedBy: [] });
    expect(result.get("acme/repo#2")).toEqual({ parent: null, blockedBy: [] });
  });

  test("treats a parent node missing owner/repo/number as no parent, not a failure", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        graphQLResponse({
          data: {
            r0: {
              i0: {
                parent: { number: null, repository: null },
                blockedBy: { nodes: [] },
              },
            },
          },
        }),
      )) as unknown as typeof fetch;

    const result = await fetchIssueRelationshipsBatch({
      accessToken: "token",
      refs: [{ owner: "acme", repo: "repo", number: 1 }],
      fetchImpl,
    });

    expect(result.get("acme/repo#1")).toEqual({ parent: null, blockedBy: [] });
  });

  test("throws GitHubIngestError when the HTTP response is not ok", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        graphQLResponse({}, { status: 502 }),
      )) as unknown as typeof fetch;

    const caught = await captureError(() =>
      fetchIssueRelationshipsBatch({
        accessToken: "token",
        refs: [{ owner: "acme", repo: "repo", number: 1 }],
        fetchImpl,
      }),
    );

    expect(caught).toBeInstanceOf(GitHubIngestError);
  });

  test("an SSO 403 names the batch's repo and needs SSO", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response("{}", {
          status: 403,
          headers: { "x-github-sso": "required; url=https://github.com/sso" },
        }),
      )) as unknown as typeof fetch;

    const caught = (await captureError(() =>
      fetchIssueRelationshipsBatch({
        accessToken: "token",
        refs: [{ owner: "acme", repo: "repo", number: 1 }],
        fetchImpl,
      }),
    )) as GitHubIngestError;

    expect(caught).toBeInstanceOf(GitHubIngestError);
    expect(caught.repoFullName).toBe("acme/repo");
    expect(caught.ssoRequired).toBe(true);
    expect(caught.rateLimited).toBe(false);
  });

  test("throws GitHubIngestError when the GraphQL response has errors and no data", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        graphQLResponse({ errors: [{ message: "Something exploded" }] }),
      )) as unknown as typeof fetch;

    const caught = await captureError(() =>
      fetchIssueRelationshipsBatch({
        accessToken: "token",
        refs: [{ owner: "acme", repo: "repo", number: 1 }],
        fetchImpl,
      }),
    );

    expect(caught).toBeInstanceOf(GitHubIngestError);
    expect((caught as Error).message).toContain("Something exploded");
  });
});
