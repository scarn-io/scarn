import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { fetchInstallationMetadata } from "@/integrations/github-installation/infra/fetch-installation-metadata";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const urlToString = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
};

const buildFetch = (responses: Map<string, () => Response>): typeof fetch => {
  return ((input: RequestInfo | URL) => {
    const urlString = urlToString(input);
    for (const [pattern, factory] of responses) {
      if (urlString.includes(pattern)) return Promise.resolve(factory());
    }
    throw new Error(`Unexpected fetch: ${urlString}`);
  }) as typeof fetch;
};

const jsonResponse = (
  status: number,
  body: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tokenResponse = () =>
  jsonResponse(201, {
    token: "ghs_test",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

describe("fetchInstallationMetadata", () => {
  test("returns parsed account + repositories", async () => {
    const fetchImpl = buildFetch(
      new Map([
        ["/app/installations/12345/access_tokens", tokenResponse],
        [
          "/app/installations/12345",
          () =>
            jsonResponse(200, {
              account: { login: "acme", type: "Organization" },
              repository_selection: "selected",
            }),
        ],
        [
          "/installation/repositories",
          () =>
            jsonResponse(200, {
              repositories: [
                { id: 1, full_name: "acme/alpha" },
                { id: 2, full_name: "acme/beta" },
                { id: 3 },
              ],
            }),
        ],
      ]),
    );

    const result = await fetchInstallationMetadata({
      appId: "1",
      privateKey,
      installationId: "12345",
      fetchImpl,
    });

    expect(result.accountLogin).toBe("acme");
    expect(result.accountType).toBe("Organization");
    expect(result.targetType).toBe("selected");
    expect(result.repositories).toEqual([
      { id: 1, fullName: "acme/alpha" },
      { id: 2, fullName: "acme/beta" },
    ]);
  });

  test("returns repositories for 'all' installations too", async () => {
    const fetchImpl = buildFetch(
      new Map([
        ["/app/installations/99/access_tokens", tokenResponse],
        [
          "/app/installations/99",
          () =>
            jsonResponse(200, {
              account: { login: "octocat", type: "User" },
              repository_selection: "all",
            }),
        ],
        [
          "/installation/repositories",
          () =>
            jsonResponse(200, {
              repositories: [{ id: 10, full_name: "octocat/hello-world" }],
            }),
        ],
      ]),
    );

    const result = await fetchInstallationMetadata({
      appId: "1",
      privateKey,
      installationId: "99",
      fetchImpl,
    });

    expect(result.accountType).toBe("User");
    expect(result.targetType).toBe("all");
    expect(result.repositories).toHaveLength(1);
  });

  test("follows pagination to collect repositories across multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      full_name: `acme/repo-${String(index + 1)}`,
    }));
    const page2 = [{ id: 101, full_name: "acme/repo-101" }];

    const fetchImpl = buildFetch(
      new Map([
        ["/app/installations/500/access_tokens", tokenResponse],
        [
          "/app/installations/500",
          () =>
            jsonResponse(200, {
              account: { login: "acme", type: "Organization" },
              repository_selection: "all",
            }),
        ],
        ["&page=1", () => jsonResponse(200, { repositories: page1 })],
        ["&page=2", () => jsonResponse(200, { repositories: page2 })],
      ]),
    );

    const result = await fetchInstallationMetadata({
      appId: "1",
      privateKey,
      installationId: "500",
      fetchImpl,
    });

    expect(result.repositories).toHaveLength(101);
    expect(result.repositories[0]).toEqual({ id: 1, fullName: "acme/repo-1" });
    expect(result.repositories[100]).toEqual({
      id: 101,
      fullName: "acme/repo-101",
    });
  });

  test("throws when GitHub returns non-2xx for installation lookup", async () => {
    const fetchImpl = buildFetch(
      new Map([
        [
          "/app/installations/404",
          () => jsonResponse(404, { message: "Not Found" }),
        ],
      ]),
    );

    let caught: unknown;
    try {
      await fetchInstallationMetadata({
        appId: "1",
        privateKey,
        installationId: "404",
        fetchImpl,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/404/);
  });
});
