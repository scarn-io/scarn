import { describe, expect, test } from "bun:test";
import { CoreError } from "@/lib/errors";
import {
  getRepo,
  getUser,
} from "@/integrations/github-ingest/infra/github-repo-access-client";

type Recorded = { url: string; headers: Headers };

const fakeFetch = (status: number, body: object) => {
  const requests: Recorded[] = [];
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
};

const caught = async (run: () => Promise<unknown>): Promise<CoreError> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("Expected a CoreError");
};

describe("getRepo", () => {
  test("reads the repo with the token as a Bearer header", async () => {
    const { fetchImpl, requests } = fakeFetch(200, {
      id: 7,
      full_name: "Acme/Api",
      has_issues: false,
    });

    const repo = await getRepo("ghp_abc", "Acme", "Api", { fetchImpl });

    expect(repo).toEqual({ id: 7, fullName: "Acme/Api", hasIssues: false });
    expect(requests[0]?.url).toBe("https://api.github.com/repos/Acme/Api");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer ghp_abc");
  });

  test("treats a missing has_issues as enabled", async () => {
    const { fetchImpl } = fakeFetch(200, { id: 7, full_name: "acme/api" });

    expect((await getRepo("t", "acme", "api", { fetchImpl })).hasIssues).toBe(
      true,
    );
  });

  test("a 401 is GITHUB_TOKEN_REJECTED naming the saved key", async () => {
    const { fetchImpl } = fakeFetch(401, { message: "Bad credentials" });

    const error = await caught(() =>
      getRepo("ghp_secret_value", "acme", "api", {
        fetchImpl,
        secretName: "Work token",
      }),
    );

    expect(error.code).toBe("GITHUB_TOKEN_REJECTED");
    expect(error.message).toContain("Work token");
    expect(error.message).not.toContain("ghp_secret_value");
  });

  test.each([403, 404])(
    "a %d is GITHUB_REPO_NOT_ACCESSIBLE with permission, approval and SSO hints",
    async (status) => {
      const { fetchImpl } = fakeFetch(status, { message: "Not Found" });

      const error = await caught(() =>
        getRepo("t", "acme", "api", { fetchImpl }),
      );

      expect(error.code).toBe("GITHUB_REPO_NOT_ACCESSIBLE");
      expect(error.status).toBe(422);
      expect(error.message).toContain("acme/api");
      expect(error.message).toContain("approved");
      expect(error.message).toContain("SSO");
    },
  );

  test("any other failure is GITHUB_REQUEST_FAILED without GitHub's body", async () => {
    const { fetchImpl } = fakeFetch(500, { message: "internal detail" });

    const error = await caught(() =>
      getRepo("t", "acme", "api", { fetchImpl }),
    );

    expect(error.code).toBe("GITHUB_REQUEST_FAILED");
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("internal detail");
  });
});

describe("getUser", () => {
  test("returns the token's login", async () => {
    const { fetchImpl, requests } = fakeFetch(200, { login: "octo" });

    expect(await getUser("ghp_abc", { fetchImpl })).toEqual({ login: "octo" });
    expect(requests[0]?.url).toBe("https://api.github.com/user");
  });

  test("a 401 is GITHUB_TOKEN_REJECTED", async () => {
    const { fetchImpl } = fakeFetch(401, {});

    expect((await caught(() => getUser("t", { fetchImpl }))).code).toBe(
      "GITHUB_TOKEN_REJECTED",
    );
  });
});
