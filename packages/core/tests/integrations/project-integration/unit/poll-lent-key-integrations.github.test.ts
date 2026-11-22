import { describe, expect, test } from "bun:test";
import { pollLentKeyIntegrations } from "@/integrations/project-integration/application/poll-lent-key-integrations";
import {
  POLL_NOW,
  createPollHarness,
  githubFetch,
  githubResponse,
  toRequestUrl,
} from "./poll-lent-key-integrations-test-support";

describe("pollLentKeyIntegrations — GitHub", () => {
  test("syncs with the lent token, marks the integration synced and the key used", async () => {
    const harness = createPollHarness();
    const key = await harness.saveGitHubToken();
    const integration = harness.addGitHub(key, ["acme/web"]);
    const github = githubFetch();
    harness.deps.fetchImpl = github.fetchImpl;

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.succeeded).toBe(1);
    expect(github.requestedRepos).toEqual(["acme/web"]);
    expect(harness.current(integration.id).status).toBe("active");
    expect(harness.current(integration.id).lastSyncedAt).toEqual(POLL_NOW);
    expect(await harness.lastUsedAt(key)).toEqual(POLL_NOW);
    expect(harness.released).toEqual([integration.id]);
  });

  test("skips an integration whose claim another run holds", async () => {
    const harness = createPollHarness();
    const key = await harness.saveGitHubToken();
    const integration = harness.addGitHub(key, ["acme/web"]);
    harness.held.add(integration.id);
    const github = githubFetch();
    harness.deps.fetchImpl = github.fetchImpl;

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.skippedLocked).toBe(1);
    expect(result.attempted).toBe(0);
    expect(github.requestedRepos).toEqual([]);
    expect(harness.released).toEqual([]);
  });

  test("a 401 pauses with key_rejected and clears the key", async () => {
    const harness = createPollHarness();
    const key = await harness.saveGitHubToken();
    const integration = harness.addGitHub(key, ["acme/web"]);
    harness.deps.fetchImpl = githubFetch({
      "acme/web": () => githubResponse(401),
    }).fetchImpl;

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.paused).toBe(1);
    const paused = harness.current(integration.id);
    expect(paused.status).toBe("paused");
    expect(paused.syncSecretId).toBeNull();
    expect(paused.autoSyncPausedReason).toBe("key_rejected");
  });

  test("an SSO 403 pauses with access_lost naming the repo", async () => {
    const harness = createPollHarness();
    const key = await harness.saveGitHubToken();
    const integration = harness.addGitHub(key, ["acme/web"]);
    harness.deps.fetchImpl = githubFetch({
      "acme/web": () =>
        githubResponse(403, { "x-github-sso": "required; url=https://x" }),
    }).fetchImpl;

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.paused).toBe(1);
    const paused = harness.current(integration.id);
    expect(paused.autoSyncPausedReason).toBe("access_lost");
    expect(paused.autoSyncPausedDetail).toBe(
      "SSO authorization required for acme/web",
    );
    expect(paused.syncSecretId).toBeNull();
  });

  test("a 404 on one repo pauses with access_lost naming that repo", async () => {
    const harness = createPollHarness();
    const key = await harness.saveGitHubToken();
    const integration = harness.addGitHub(key, ["acme/web", "acme/api"]);
    harness.deps.fetchImpl = githubFetch({
      "acme/api": () => githubResponse(404),
    }).fetchImpl;

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.paused).toBe(1);
    const paused = harness.current(integration.id);
    expect(paused.autoSyncPausedReason).toBe("access_lost");
    expect(paused.autoSyncPausedDetail).toBe("No access to acme/api");
    expect(harness.notifications.map((n) => n.body)).toEqual([
      "Auto-sync for acme/web, acme/api paused: alice's key lost access. No access to acme/api.",
      "Auto-sync for acme/web, acme/api paused: alice's key lost access. No access to acme/api.",
    ]);
  });

  test.each([
    [403, { "x-ratelimit-remaining": "0" }],
    [429, { "retry-after": "60" }],
  ])(
    "a rate-limit %i skips without pausing or marking error",
    async (status, headers) => {
      const harness = createPollHarness();
      const key = await harness.saveGitHubToken();
      const integration = harness.addGitHub(key, ["acme/web"]);
      harness.deps.fetchImpl = githubFetch({
        "acme/web": () => githubResponse(status, headers),
      }).fetchImpl;

      const result = await pollLentKeyIntegrations(harness.deps);

      expect(result.skippedRateLimited).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.paused).toBe(0);
      const skipped = harness.current(integration.id);
      expect(skipped.status).toBe("active");
      expect(skipped.lastError).toBeNull();
      expect(skipped.syncSecretId).toBe(key.id);
      expect(harness.released).toEqual([integration.id]);
    },
  );

  test("a generic error marks error and keeps the key; the others still sync", async () => {
    const harness = createPollHarness();
    const key = await harness.saveGitHubToken();
    const failing = harness.addGitHub(key, ["acme/broken"]);
    const healthy = harness.addGitHub(key, ["acme/web"]);
    harness.deps.fetchImpl = githubFetch({
      "acme/broken": () => githubResponse(500),
    }).fetchImpl;

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    const failed = harness.current(failing.id);
    expect(failed.status).toBe("error");
    expect(failed.syncSecretId).toBe(key.id);
    expect(harness.current(healthy.id).status).toBe("active");
  });

  test("once one key's budget runs low its other integrations are skipped, while another key's still sync", async () => {
    const harness = createPollHarness();
    const lowKey = await harness.saveGitHubToken("Low budget");
    const okKey = await harness.saveGitHubToken("Healthy budget");
    harness.addGitHub(lowKey, ["acme/low-0"]);
    const okIntegrations = [
      harness.addGitHub(okKey, ["acme/ok-0"]),
      harness.addGitHub(okKey, ["acme/ok-1"]),
    ];
    const lowRest = [
      harness.addGitHub(lowKey, ["acme/low-1"]),
      harness.addGitHub(lowKey, ["acme/low-2"]),
    ];
    // More integrations than the pool of 5, so the low key's later ones
    // start only after its first sync has tripped the signal.
    for (let i = 3; i < 6; i += 1) {
      lowRest.push(harness.addGitHub(lowKey, [`acme/low-${String(i)}`]));
    }
    const lowBudget = () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "5",
        },
      });
    const github = githubFetch({ "acme/low-0": lowBudget });
    const slowFetch = github.fetchImpl;
    harness.deps.fetchImpl = (async (input: string | URL | Request) => {
      if (!toRequestUrl(input).includes("acme/low-0")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return slowFetch(input);
    }) as typeof fetch;

    const result = await pollLentKeyIntegrations(harness.deps);

    for (const integration of okIntegrations) {
      expect(harness.current(integration.id).lastSyncedAt).toEqual(POLL_NOW);
    }
    const lowSynced = github.requestedRepos.filter((repo) =>
      repo.startsWith("acme/low-"),
    );
    expect(lowSynced[0]).toBe("acme/low-0");
    expect(lowSynced.length).toBeLessThan(6);
    expect(result.skippedRateLimited).toBe(6 - lowSynced.length);
    expect(result.failed).toBe(0);
    expect(result.paused).toBe(0);
    for (const integration of lowRest) {
      expect(harness.current(integration.id).status).toBe("active");
      expect(harness.current(integration.id).syncSecretId).toBe(lowKey.id);
    }
  });
});
