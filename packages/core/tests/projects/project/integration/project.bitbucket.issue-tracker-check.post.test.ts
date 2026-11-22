import { afterEach, describe, expect, test } from "bun:test";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  bitbucketApiTokenInput,
  createSecretsTestUser,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import {
  basicAuth,
  countSecretsFor,
  createGitHubEnvGuard,
  installBitbucketFetchStub,
  loadSecretLastUsedAt,
  type BitbucketStubOptions,
} from "./project-setup-test-support";

const GIT_URL = "https://bitbucket.org/acme/api.git";

/**
 * `POST /projects/issue-tracker-check` with a Bitbucket tracker.
 * `globalThis.fetch` is stubbed for the Bitbucket API, so tests run serially.
 */
describe("POST /projects/issue-tracker-check — Bitbucket", () => {
  const env = createGitHubEnvGuard();

  afterEach(() => {
    env.restore();
  });

  const setUp = async (bitbucket: BitbucketStubOptions = {}) => {
    env.clear();
    const requests = installBitbucketFetchStub(bitbucket);
    const apiClient = createScarnTreaty(
      createApp(
        createAppContext({ timeProvider: fixedTimeProvider(SECRETS_TEST_NOW) }),
      ),
    );
    const owner = await createSecretsTestUser();
    const check = (credential: Record<string, unknown>, gitUrl = GIT_URL) =>
      apiClient.api.projects["issue-tracker-check"].post(
        {
          gitUrl,
          issueTracker: { type: "bitbucket", credential: credential as never },
        },
        { headers: owner.authHeaders },
      );
    const listProjects = () =>
      unwrapAsync(apiClient.api.projects.get({ headers: owner.authHeaders }));
    return { apiClient, owner, check, requests, listProjects };
  };

  test("a token that can read the repo returns its account with basic auth and writes nothing", async () => {
    const { owner, check, requests, listProjects } = await setUp({
      displayName: "Acme Dev",
    });

    const result = await unwrapAsync(
      check({ email: "me@acme.test", apiToken: "bb-check-1" }),
    );

    expect(result).toEqual({
      ok: true,
      account: "Acme Dev",
      issuesEnabled: true,
      repo: null,
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.authorization).toBe(
        basicAuth("me@acme.test", "bb-check-1"),
      );
    }
    expect(await listProjects()).toEqual([]);
    expect(await countSecretsFor(owner.userId)).toBe(0);
  });

  test("a saved token is checked without being marked used", async () => {
    const { apiClient, owner, check } = await setUp();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(bitbucketApiTokenInput(), {
        headers: owner.authHeaders,
      }),
    );

    await unwrapAsync(check({ secretId: secret.id }));

    expect(await loadSecretLastUsedAt(secret.id)).toBeNull();
  });

  test("a rejected token is BITBUCKET_API_TOKEN_REJECTED without the token", async () => {
    const { check } = await setUp({ repoStatus: 401 });

    const { data, error } = await check({
      email: "me@acme.test",
      apiToken: "bb-leak-check-42",
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "BITBUCKET_API_TOKEN_REJECTED",
    });
    expect(JSON.stringify(error?.value)).not.toContain("bb-leak-check-42");
  });

  test("another user's saved token is a 404 with no outbound call", async () => {
    const { apiClient, check, requests } = await setUp();
    const stranger = await createSecretsTestUser();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(bitbucketApiTokenInput(), {
        headers: stranger.authHeaders,
      }),
    );

    const { error } = await check({ secretId: secret.id });

    expect(error?.status).toBe(404);
    expect(requests).toEqual([]);
  });

  test("a GitHub-shaped credential is CREDENTIAL_PLATFORM_MISMATCH", async () => {
    const { check, requests } = await setUp();

    const { error } = await check({ token: "ghp_wrong" });

    expect(error?.value).toMatchObject({
      code: "CREDENTIAL_PLATFORM_MISMATCH",
    });
    expect(requests).toEqual([]);
  });

  test("a repo with its issue tracker off is BITBUCKET_ISSUES_DISABLED", async () => {
    const { check, listProjects } = await setUp({ hasIssues: false });

    const { error } = await check({
      email: "me@acme.test",
      apiToken: "bb-check-2",
    });

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "BITBUCKET_ISSUES_DISABLED" });
    expect(await listProjects()).toEqual([]);
  });

  test("a Bitbucket tracker on a GitHub URL is ISSUE_TRACKER_HOST_MISMATCH", async () => {
    const { check, requests } = await setUp();

    const { error } = await check(
      { email: "me@acme.test", apiToken: "bb-check-3" },
      "https://github.com/acme/api.git",
    );

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "ISSUE_TRACKER_HOST_MISMATCH" });
    expect(requests).toEqual([]);
  });
});
