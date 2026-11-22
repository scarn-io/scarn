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

const GIT_URL = "git@bitbucket.org:Acme/API.git";

/**
 * `POST /projects` with a Bitbucket issue tracker. `globalThis.fetch` is
 * stubbed for the Bitbucket API, so tests run serially.
 */
describe("POST /projects — Bitbucket issue tracker", () => {
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
    const create = (credential: Record<string, unknown>, gitUrl = GIT_URL) =>
      apiClient.api.projects.post(
        {
          name: "Bitbucket Project",
          description: null,
          gitUrl,
          issueTracker: { type: "bitbucket", credential: credential as never },
        },
        { headers: owner.authHeaders },
      );
    const listProjects = () =>
      unwrapAsync(apiClient.api.projects.get({ headers: owner.authHeaders }));
    return { apiClient, owner, create, requests, listProjects };
  };

  test("a pasted pair creates a user_credential integration, syncs with basic auth, and saves no secret", async () => {
    const { apiClient, owner, create, requests } = await setUp();

    const project = await unwrapAsync(
      create({ email: "me@acme.test", apiToken: "bb-token-1" }),
    );

    expect(project).toMatchObject({
      gitUrl: GIT_URL,
      initialSyncFailed: false,
    });
    const integrations = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      kind: "bitbucket",
      platform: "bitbucket",
      authMode: "user_credential",
      externalScope: {
        repos: [{ workspace: "Acme", slug: "API", fullName: "Acme/API" }],
      },
    });
    expect(requests.some((r) => r.url.includes("/issues"))).toBe(true);
    for (const request of requests) {
      expect(request.authorization).toBe(
        basicAuth("me@acme.test", "bb-token-1"),
      );
    }
    expect(await countSecretsFor(owner.userId)).toBe(0);
  });

  test("a saved token is used and marked used", async () => {
    const { apiClient, owner, create, requests } = await setUp();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        bitbucketApiTokenInput({ email: "saved@acme.test", value: "saved-bb" }),
        { headers: owner.authHeaders },
      ),
    );

    await unwrapAsync(create({ secretId: secret.id }));

    expect(new Set(requests.map((r) => r.authorization))).toEqual(
      new Set([basicAuth("saved@acme.test", "saved-bb")]),
    );
    expect((await loadSecretLastUsedAt(secret.id))?.toISOString()).toBe(
      SECRETS_TEST_NOW.toISOString(),
    );
  });

  test("a Bitbucket tracker on a GitHub URL is ISSUE_TRACKER_HOST_MISMATCH", async () => {
    const { create, requests, listProjects } = await setUp();

    const { error } = await create(
      { email: "me@acme.test", apiToken: "bb-token-2" },
      "https://github.com/acme/api.git",
    );

    expect(error?.value).toMatchObject({ code: "ISSUE_TRACKER_HOST_MISMATCH" });
    expect(requests).toEqual([]);
    expect(await listProjects()).toEqual([]);
  });

  test("an inaccessible repo creates no project", async () => {
    const { create, listProjects } = await setUp({ repoStatus: 404 });

    const { error } = await create({
      email: "me@acme.test",
      apiToken: "bb-token-3",
    });

    expect(error?.value).toMatchObject({
      code: "BITBUCKET_REPO_NOT_ACCESSIBLE",
    });
    expect(await listProjects()).toEqual([]);
  });
});
