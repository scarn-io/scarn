/**
 * Shared set-up for the `POST /projects` / repo-check / issue-tracker-check
 * suites: recording `globalThis.fetch` stand-ins for the GitHub and Bitbucket
 * APIs, GitHub App env handling, and seeding an App installation. Suites using it mutate
 * process-global state, so their tests run serially.
 */

import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { secrets } from "@/lib/db/schema";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { GitHubInstallationEntity } from "@/integrations/github-installation/domain/github-installation-entity";
import type { GitHubInstallationRepo } from "@/integrations/github-installation/application/github-installation-repo";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const GITHUB_ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

/** Clears the GitHub App env before each test and restores it after. */
export const createGitHubEnvGuard = () => {
  let saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  return {
    clear: () => {
      saved = {};
      for (const key of GITHUB_ENV_KEYS) {
        saved[key] = process.env[key];
        Reflect.deleteProperty(process.env, key);
      }
    },
    restore: () => {
      for (const key of GITHUB_ENV_KEYS) {
        if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = saved[key];
      }
      globalThis.fetch = originalFetch;
    },
    configureApp: () => {
      process.env["GITHUB_APP_ID"] = "test-app-id";
      process.env["GITHUB_APP_SLUG"] = "test-app-slug";
      process.env["GITHUB_APP_PRIVATE_KEY"] = privateKey;
    },
  };
};

export type RecordedGitHubRequest = {
  url: string;
  authorization: string | null;
};

export type GitHubStubOptions = {
  /** Status for `GET /repos/{owner}/{name}`; 200 serves `repo`. */
  repoStatus?: number;
  repo?: { id: number; fullName: string; hasIssues?: boolean };
  /** Status for `GET /user`; 200 serves `login`. */
  userStatus?: number;
  login?: string;
  /** Status for the issue listing a sync makes; 200 serves `[]`. */
  issuesStatus?: number;
};

const toRequestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

const authorizationOf = (init: RequestInit | undefined): string | null => {
  const headers = new Headers(init?.headers);
  return headers.get("authorization");
};

const json = (body: object, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Replaces `globalThis.fetch` with a GitHub API stand-in and returns every
 * request it saw. Any other URL fails the test.
 */
export const installGitHubFetchStub = (
  options: GitHubStubOptions = {},
): RecordedGitHubRequest[] => {
  const requests: RecordedGitHubRequest[] = [];
  const repo = options.repo ?? { id: 101, fullName: "acme/api" };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = toRequestUrl(input);
    requests.push({ url, authorization: authorizationOf(init) });
    const path = new URL(url).pathname;
    if (path.endsWith("/access_tokens")) {
      return Promise.resolve(
        json({
          token: "test-installation-token",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
    }
    if (path.endsWith("/issues")) {
      const status = options.issuesStatus ?? 200;
      return Promise.resolve(
        status === 200 ? json([]) : json({ message: "nope" }, status),
      );
    }
    if (path === "/user") {
      const status = options.userStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? json({ login: options.login ?? "octo-user" })
          : json({ message: "Bad credentials" }, status),
      );
    }
    if (path.startsWith("/repos/")) {
      const status = options.repoStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? json({
              id: repo.id,
              full_name: repo.fullName,
              has_issues: repo.hasIssues ?? true,
            })
          : json({ message: "Not Found" }, status),
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
  return requests;
};

export type BitbucketStubOptions = {
  /** Status for `GET /repositories/{ws}/{slug}`; 200 serves the repo. */
  repoStatus?: number;
  hasIssues?: boolean;
  /** Status for `GET /user`; 200 serves `displayName`. */
  userStatus?: number;
  displayName?: string;
};

/**
 * Replaces `globalThis.fetch` with a Bitbucket Cloud API stand-in and returns
 * every request it saw. Any other URL fails the test.
 */
export const installBitbucketFetchStub = (
  options: BitbucketStubOptions = {},
): RecordedGitHubRequest[] => {
  const requests: RecordedGitHubRequest[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = toRequestUrl(input);
    requests.push({ url, authorization: authorizationOf(init) });
    const { hostname, pathname } = new URL(url);
    if (hostname !== "api.bitbucket.org") {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    if (pathname.endsWith("/issues")) {
      return Promise.resolve(json({ values: [] }));
    }
    if (pathname === "/2.0/user") {
      const status = options.userStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? json({ display_name: options.displayName ?? "Bit Bucketeer" })
          : json({ type: "error" }, status),
      );
    }
    const repoMatch = /^\/2\.0\/repositories\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (repoMatch) {
      const status = options.repoStatus ?? 200;
      const [, workspace = "", slug = ""] = repoMatch;
      return Promise.resolve(
        status === 200
          ? json({
              full_name: `${workspace}/${slug}`,
              slug,
              workspace: { slug: workspace },
              has_issues: options.hasIssues ?? true,
            })
          : json({ type: "error" }, status),
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
  return requests;
};

export const basicAuth = (email: string, token: string): string =>
  `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

export const seedInstallation = async (
  githubInstallationRepo: GitHubInstallationRepo,
  ownerUserId: string,
  installationId: string,
  repo: { id: number; fullName: string },
) => {
  await githubInstallationRepo.upsert(
    GitHubInstallationEntity.create({
      installationId,
      accountLogin: repo.fullName.split("/")[0] ?? null,
      accountType: "User",
      targetType: "selected",
      selectedRepositories: [repo],
      installedByUserId: parseUuidV7(ownerUserId),
    }),
  );
};

export const countSecretsFor = async (userId: string): Promise<number> =>
  (
    await getDb()
      .select({ id: secrets.id })
      .from(secrets)
      .where(eq(secrets.ownerUserId, userId))
  ).length;

export const loadSecretLastUsedAt = async (
  secretId: string,
): Promise<Date | null> => {
  const [row] = await getDb()
    .select({ lastUsedAt: secrets.lastUsedAt })
    .from(secrets)
    .where(eq(secrets.id, secretId));
  return row?.lastUsedAt ?? null;
};
