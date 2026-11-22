import { describe, expect, test } from "bun:test";
import {
  fetchRepoIssues,
  GitHubIngestError,
} from "@/integrations/github-ingest/infra/github-issues-client";

const captureError = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (caught: unknown) {
    return caught;
  }
  throw new Error("Expected the operation to throw, but it resolved");
};

const failWith = (status: number, headers: Record<string, string> = {}) =>
  (() =>
    Promise.resolve(
      new Response("{}", { status, headers }),
    )) as unknown as typeof fetch;

const fetchFailure = (fetchImpl: typeof fetch) =>
  captureError(() =>
    fetchRepoIssues({
      accessToken: "token",
      owner: "acme",
      repo: "widgets",
      fetchImpl,
    }),
  );

describe("fetchRepoIssues errors", () => {
  test("a 403 with X-GitHub-SSO names the repo and needs SSO", async () => {
    const caught = await fetchFailure(
      failWith(403, { "x-github-sso": "required; url=https://github.com/sso" }),
    );

    expect(caught).toBeInstanceOf(GitHubIngestError);
    const error = caught as GitHubIngestError;
    expect(error.status).toBe(403);
    expect(error.repoFullName).toBe("acme/widgets");
    expect(error.ssoRequired).toBe(true);
    expect(error.rateLimited).toBe(false);
  });

  test("a rate-limited 403 is not mistaken for lost access", async () => {
    const caught = (await fetchFailure(
      failWith(403, { "x-ratelimit-remaining": "0" }),
    )) as GitHubIngestError;

    expect(caught.repoFullName).toBe("acme/widgets");
    expect(caught.rateLimited).toBe(true);
    expect(caught.ssoRequired).toBe(false);
  });

  test("a 404 names the repo and is neither SSO nor a rate limit", async () => {
    const caught = (await fetchFailure(failWith(404))) as GitHubIngestError;

    expect(caught.status).toBe(404);
    expect(caught.repoFullName).toBe("acme/widgets");
    expect(caught.ssoRequired).toBe(false);
    expect(caught.rateLimited).toBe(false);
  });
});
