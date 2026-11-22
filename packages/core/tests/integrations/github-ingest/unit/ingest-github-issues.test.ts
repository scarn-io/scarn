import { describe, expect, test } from "bun:test";
import { ingestGitHubIssues } from "@/integrations/github-ingest/application/ingest-github-issues";
import type { GitHubIssue } from "@/integrations/github-ingest/infra/github-issues-client";
import type { UpsertWorkItemInput } from "@/work-items/work-item/contracts/work-item-contracts";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");

const makeIssue = (overrides: Partial<GitHubIssue>): GitHubIssue => ({
  id: overrides.id ?? 1,
  node_id: overrides.node_id ?? "I_kw1",
  number: overrides.number ?? 1,
  title: overrides.title ?? "Issue",
  body: overrides.body ?? "Body",
  html_url: overrides.html_url ?? "https://github.com/acme/repo/issues/1",
  state: overrides.state ?? "open",
  state_reason: overrides.state_reason ?? null,
  user: overrides.user ?? { login: "alice" },
  labels: overrides.labels ?? [],
  assignees: overrides.assignees ?? [],
  comments: overrides.comments ?? 0,
  created_at: overrides.created_at ?? "2026-05-01T00:00:00Z",
  updated_at: overrides.updated_at ?? "2026-05-01T00:00:00Z",
  closed_at: overrides.closed_at ?? null,
  pull_request: overrides.pull_request,
});

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonResponse = (
  body: JsonValue,
  init: { status?: number; nextUrl?: string } = {},
): Response => {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.nextUrl) {
    headers.set("link", `<${init.nextUrl}>; rel="next"`);
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
};

const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

describe("ingestGitHubIssues", () => {
  test("paginates via Link header, filters PRs, and calls upsertWorkItems", async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      calls.push(toRequestUrl(input));
      if (calls.length === 1) {
        return Promise.resolve(
          jsonResponse(
            [
              makeIssue({ id: 1, number: 1, node_id: "I_1" }) as JsonValue,
              makeIssue({
                id: 2,
                number: 2,
                node_id: "I_2",
                pull_request: { url: "..." },
              }) as JsonValue,
            ],
            { nextUrl: "https://api.github.com/repositories/x/issues?page=2" },
          ),
        );
      }
      return Promise.resolve(
        jsonResponse([
          makeIssue({ id: 3, number: 3, node_id: "I_3" }) as JsonValue,
        ]),
      );
    }) as unknown as typeof fetch;

    const upserted: UpsertWorkItemInput[][] = [];
    const result = await ingestGitHubIssues(
      {
        projectId,
        accessToken: "test-token",
        repos: [{ fullName: "acme/repo" }],
        fetchImpl,
      },
      (items) => {
        upserted.push(items);
        return Promise.resolve();
      },
    );

    expect(calls).toHaveLength(2);
    expect(result.totalUpserted).toBe(2);
    expect(result.perRepo[0]?.fullName).toBe("acme/repo");
    expect(result.perRepo[0]?.totalSeen).toBe(3);
    expect(result.perRepo[0]?.totalUpserted).toBe(2);
    expect(result.perRepo[0]?.issues.map((issue) => issue.number)).toEqual([
      1, 3,
    ]);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.map((entry) => entry.platformKey)).toEqual([
      "acme/repo#1",
      "acme/repo#3",
    ]);
  });

  test("passes since param when provided", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = ((input: string | URL | Request) => {
      seenUrls.push(toRequestUrl(input));
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;

    await ingestGitHubIssues(
      {
        projectId,
        accessToken: "t",
        repos: [{ fullName: "acme/repo" }],
        sinceIso: "2026-05-20T00:00:00Z",
        fetchImpl,
      },
      () => Promise.resolve(),
    );

    const first = seenUrls[0] ?? "";
    expect(first).toContain("since=2026-05-20T00%3A00%3A00Z");
    expect(first).toContain("state=all");
  });

  test("returns maxSourceUpdatedAt as the max updated_at across all repos", async () => {
    const fetchImpl = ((input: string | URL | Request) => {
      const url = toRequestUrl(input);
      if (url.includes("/repos/acme/repo-a/issues")) {
        return Promise.resolve(
          jsonResponse([
            makeIssue({
              id: 1,
              number: 1,
              node_id: "I_1",
              updated_at: "2026-05-10T00:00:00Z",
            }) as JsonValue,
          ]),
        );
      }
      return Promise.resolve(
        jsonResponse([
          makeIssue({
            id: 2,
            number: 2,
            node_id: "I_2",
            updated_at: "2026-05-25T08:00:00Z",
          }) as JsonValue,
          makeIssue({
            id: 3,
            number: 3,
            node_id: "I_3",
            updated_at: "2026-05-01T00:00:00Z",
          }) as JsonValue,
        ]),
      );
    }) as unknown as typeof fetch;

    const result = await ingestGitHubIssues(
      {
        projectId,
        accessToken: "test-token",
        repos: [{ fullName: "acme/repo-a" }, { fullName: "acme/repo-b" }],
        fetchImpl,
      },
      () => Promise.resolve(),
    );

    expect(result.maxSourceUpdatedAt).toBe("2026-05-25T08:00:00Z");
  });

  test("returns null maxSourceUpdatedAt when zero issues are seen across every repo", async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse([]))) as unknown as typeof fetch;

    const result = await ingestGitHubIssues(
      {
        projectId,
        accessToken: "test-token",
        repos: [{ fullName: "acme/repo-a" }, { fullName: "acme/repo-b" }],
        fetchImpl,
      },
      () => Promise.resolve(),
    );

    expect(result.maxSourceUpdatedAt).toBeNull();
  });
});
