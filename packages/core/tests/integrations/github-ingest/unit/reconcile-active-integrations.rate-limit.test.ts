import { describe, expect, test } from "bun:test";
import { reconcileActiveIntegrations } from "@/integrations/github-ingest/application/reconcile-active-integrations";
import {
  baseDeps,
  jsonResponse,
  makeGitHubIntegration,
  makeProjectIntegrationRepo,
  toRequestUrl,
} from "./reconcile-active-integrations-test-support";

describe("reconcileActiveIntegrations — GitHub rate-limit backoff (Phase 5)", () => {
  test("stops dispatching new integrations once a response reports a low X-RateLimit-Remaining, resuming next run", async () => {
    const INTEGRATION_COUNT = 8;
    const integrations = Array.from({ length: INTEGRATION_COUNT }, (_, i) =>
      makeGitHubIntegration(`rl-install-${String(i)}`, `acme/rl-repo-${String(i)}`),
    );
    const { repo: projectIntegrationRepo } =
      makeProjectIntegrationRepo(integrations);

    // `acme/rl-repo-0`'s issues response reports a rate-limit budget under
    // the threshold and resolves immediately (no delay), so it's the first
    // integration to finish and observe the low-budget response. Every
    // other repo's issues response is healthy but held open briefly, so
    // this integration's pool worker loops back for more work — and finds
    // the gate already tripped — before any of the other four
    // concurrently-dispatched integrations (the pool is bounded to 5) have
    // even finished their own first sync.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = toRequestUrl(input);
      if (url.includes("/access_tokens")) {
        return jsonResponse({
          token: "installation-token",
          expires_at: "2026-05-24T13:00:00Z",
        });
      }
      if (url.includes("/graphql")) {
        return jsonResponse({ data: {} });
      }
      if (url.includes("/repos/acme/rl-repo-0/issues")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "5",
          },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    const deps = baseDeps();
    const result = await reconcileActiveIntegrations({
      ...deps,
      projectIntegrationRepo,
      fetchImpl,
    });

    // Only the pool's initial batch (bounded to 5, decision 17) was ever
    // dispatched — the remaining 3 integrations were never attempted this
    // run because the gate tripped before the pool asked for more work.
    expect(result.integrationsAttempted).toBe(5);
    expect(result.integrationsSucceeded).toBe(5);
    expect(result.integrationsFailed).toBe(0);
  });

  test("a healthy X-RateLimit-Remaining never trips the gate — every integration is attempted", async () => {
    const INTEGRATION_COUNT = 3;
    const integrations = Array.from({ length: INTEGRATION_COUNT }, (_, i) =>
      makeGitHubIntegration(`rl-ok-install-${String(i)}`, `acme/rl-ok-repo-${String(i)}`),
    );
    const { repo: projectIntegrationRepo } =
      makeProjectIntegrationRepo(integrations);

    const fetchImpl = ((input: string | URL | Request) => {
      const url = toRequestUrl(input);
      if (url.includes("/access_tokens")) {
        return Promise.resolve(
          jsonResponse({
            token: "installation-token",
            expires_at: "2026-05-24T13:00:00Z",
          }),
        );
      }
      if (url.includes("/graphql")) {
        return Promise.resolve(jsonResponse({ data: {} }));
      }
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
          },
        }),
      );
    }) as unknown as typeof fetch;

    const deps = baseDeps();
    const result = await reconcileActiveIntegrations({
      ...deps,
      projectIntegrationRepo,
      fetchImpl,
    });

    expect(result.integrationsAttempted).toBe(INTEGRATION_COUNT);
    expect(result.integrationsSucceeded).toBe(INTEGRATION_COUNT);
    expect(result.integrationsFailed).toBe(0);
  });
});
