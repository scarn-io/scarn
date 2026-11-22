import { describe, expect, test } from "bun:test";
import { reconcileActiveIntegrations } from "@/integrations/github-ingest/application/reconcile-active-integrations";
import {
  baseDeps,
  jsonResponse,
  makeFetchImpl,
  makeGitHubIntegration,
  makeGitHubTokenIntegration,
  makeIssue,
  makeJiraIntegration,
  makeProjectIntegrationRepo,
  toRequestUrl,
} from "./reconcile-active-integrations-test-support";

describe("reconcileActiveIntegrations", () => {
  test("one failing integration doesn't abort the rest; reports correct attempted/succeeded/failed counts", async () => {
    const failing = makeGitHubIntegration("fail-install", "acme/broken");
    const succeeding = makeGitHubIntegration("ok-install", "acme/healthy");
    const { repo: projectIntegrationRepo } = makeProjectIntegrationRepo([
      failing,
      succeeding,
    ]);
    const { fetchImpl } = makeFetchImpl({
      failingInstallationId: "fail-install",
      issuesByRepo: {
        "acme/healthy": [makeIssue(1, "2026-05-01T00:00:00Z")],
      },
    });

    const deps = baseDeps();
    const result = await reconcileActiveIntegrations({
      ...deps,
      projectIntegrationRepo,
      fetchImpl,
    });

    expect(result.integrationsAttempted).toBe(2);
    expect(result.integrationsSucceeded).toBe(1);
    expect(result.integrationsFailed).toBe(1);
    // The succeeding integration's work items were actually upserted.
    expect(deps.savedBatches.flat()).toHaveLength(1);
  });

  test("listActive() excludes paused integrations — never attempted", async () => {
    const active = makeGitHubIntegration("active-install", "acme/active");
    const paused = makeGitHubIntegration(
      "paused-install",
      "acme/paused",
      "paused",
    );
    const { repo: projectIntegrationRepo } = makeProjectIntegrationRepo([
      active,
      paused,
    ]);
    const { fetchImpl, calls } = makeFetchImpl({
      issuesByRepo: { "acme/active": [] },
    });

    const deps = baseDeps();
    const result = await reconcileActiveIntegrations({
      ...deps,
      projectIntegrationRepo,
      fetchImpl,
    });

    expect(result.integrationsAttempted).toBe(1);
    expect(result.integrationsSucceeded).toBe(1);
    expect(result.integrationsFailed).toBe(0);
    expect(
      calls.some((url) => url.includes("/installations/paused-install/")),
    ).toBe(false);
  });

  test("processes integrations with bounded concurrency (pool of 5), not one at a time", async () => {
    const INTEGRATION_COUNT = 12;
    const integrations = Array.from({ length: INTEGRATION_COUNT }, (_, i) =>
      makeGitHubIntegration(
        `bounded-install-${String(i)}`,
        `acme/repo-${String(i)}`,
      ),
    );
    const { repo: projectIntegrationRepo } =
      makeProjectIntegrationRepo(integrations);

    let inFlightIssueRequests = 0;
    let maxInFlightIssueRequests = 0;
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
      // Only the issues-listing request is held open, so overlap here
      // reflects how many integrations are being synced concurrently.
      inFlightIssueRequests += 1;
      maxInFlightIssueRequests = Math.max(
        maxInFlightIssueRequests,
        inFlightIssueRequests,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlightIssueRequests -= 1;
      return jsonResponse([]);
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
    // Bounded by the hardcoded pool size of 5 (decision 17) — never more
    // than 5 issue requests in flight at once...
    expect(maxInFlightIssueRequests).toBeLessThanOrEqual(5);
    // ...but more than 1, proving this isn't a serial `for...of` loop.
    expect(maxInFlightIssueRequests).toBeGreaterThan(1);
  });

  test("skips non-github (jira) integrations entirely — not attempted, not passed to runProjectIntegrationSync", async () => {
    const github = makeGitHubIntegration("gh-install", "acme/repo");
    const jira = makeJiraIntegration();
    const { repo: projectIntegrationRepo } = makeProjectIntegrationRepo([
      jira,
      github,
    ]);
    const { fetchImpl, calls } = makeFetchImpl({
      issuesByRepo: { "acme/repo": [] },
    });

    const deps = baseDeps();
    const result = await reconcileActiveIntegrations({
      ...deps,
      projectIntegrationRepo,
      fetchImpl,
    });

    expect(result.integrationsAttempted).toBe(1);
    expect(result.integrationsSucceeded).toBe(1);
    expect(result.integrationsFailed).toBe(0);
    expect(calls.some((url) => url.includes("atlassian"))).toBe(false);
  });

  test("skips github_token integrations — a scheduled run has no user credential to sync with", async () => {
    const github = makeGitHubIntegration("gh-install", "acme/repo");
    const token = makeGitHubTokenIntegration("acme/private");
    const { repo: projectIntegrationRepo, findByIdOrder } =
      makeProjectIntegrationRepo([token, github]);
    const { fetchImpl, calls } = makeFetchImpl({
      issuesByRepo: { "acme/repo": [] },
    });

    const deps = baseDeps();
    const result = await reconcileActiveIntegrations({
      ...deps,
      projectIntegrationRepo,
      fetchImpl,
    });

    expect(result.integrationsAttempted).toBe(1);
    expect(result.integrationsSucceeded).toBe(1);
    expect(result.integrationsFailed).toBe(0);
    expect(findByIdOrder).not.toContain(token.id);
    expect(calls.some((url) => url.includes("acme/private"))).toBe(false);
  });
});
