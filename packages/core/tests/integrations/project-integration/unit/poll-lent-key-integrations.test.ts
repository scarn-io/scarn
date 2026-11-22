import { describe, expect, test } from "bun:test";
import { pollLentKeyIntegrations } from "@/integrations/project-integration/application/poll-lent-key-integrations";
import { JIRA_SCHEDULED_OVERLAP_MS } from "@/integrations/jira-ingest/application/sync-jira-integration";
import { markProjectIntegrationSynced } from "@/integrations/project-integration/application/mark-project-integration-synced";
import { JiraIngestError } from "@/integrations/jira-ingest/infra/jira-issues-client";
import { jiraCredentialRejectedError } from "@/secrets/secret/application/resolve-jira-credential";
import {
  POLL_NOW,
  createPollHarness,
} from "./poll-lent-key-integrations-test-support";

const SYNC_CLAIM_MS = 4 * 60 * 1000;

describe("pollLentKeyIntegrations — Jira and shared behaviour", () => {
  test("syncs with the lent key and the 2-minute overlap, then marks the integration synced and the key used", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const integration = harness.addJira(key);
    const calls: Array<{ email: string; overlapMs: number | undefined }> = [];
    harness.deps.syncJira = async (target, credential, deps, options) => {
      calls.push({ email: credential.email, overlapMs: options?.overlapMs });
      await markProjectIntegrationSynced(
        target.id,
        POLL_NOW,
        deps.projectIntegrationRepo,
      );
      return { totalUpserted: 0, perSource: [] };
    };

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      paused: 0,
      skippedLocked: 0,
      skippedRateLimited: 0,
    });
    expect(calls).toEqual([
      { email: "lender@example.com", overlapMs: JIRA_SCHEDULED_OVERLAP_MS },
    ]);
    expect(harness.current(integration.id).status).toBe("active");
    expect(harness.current(integration.id).lastSyncedAt).toEqual(POLL_NOW);
    expect(await harness.lastUsedAt(key)).toEqual(POLL_NOW);
    expect(harness.claims).toEqual([
      {
        id: integration.id,
        until: new Date(POLL_NOW.getTime() + SYNC_CLAIM_MS),
      },
    ]);
    expect(harness.released).toEqual([integration.id]);
  });

  test("skips an integration whose claim another run holds", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const held = harness.addJira(key);
    harness.addJira(key);
    harness.held.add(held.id);
    let synced = 0;
    harness.deps.syncJira = () => {
      synced += 1;
      return Promise.resolve({ totalUpserted: 0, perSource: [] });
    };

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.skippedLocked).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(synced).toBe(1);
    expect(harness.released).not.toContain(held.id);
  });

  test("a rejected key pauses with key_rejected and clears the key", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const integration = harness.addJira(key);
    harness.deps.syncJira = (_target, credential) =>
      Promise.reject(jiraCredentialRejectedError(credential));

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.paused).toBe(1);
    expect(result.failed).toBe(0);
    const paused = harness.current(integration.id);
    expect(paused.status).toBe("paused");
    expect(paused.syncSecretId).toBeNull();
    expect(paused.autoSyncPausedReason).toBe("key_rejected");
    expect(paused.autoSyncPausedAt).toEqual(POLL_NOW);
    expect(await harness.lastUsedAt(key)).toBeNull();
    expect(harness.released).toEqual([integration.id]);
  });

  test("an unusable lent key (owner's key deleted) pauses with key_removed", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const integration = harness.addJira(key);
    await harness.deps.secretRepo.delete(key.id, key.owner);

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.paused).toBe(1);
    expect(harness.current(integration.id).autoSyncPausedReason).toBe(
      "key_removed",
    );
  });

  test("after the key's owner leaves the project, a poll pauses with owner_left_project and notifies writers and the owner", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const integration = harness.addJira(key);
    harness.ownerLeavesProject();

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.paused).toBe(1);
    const paused = harness.current(integration.id);
    expect(paused.autoSyncPausedReason).toBe("owner_left_project");
    expect(paused.syncSecretId).toBeNull();
    expect(harness.notifications.map((n) => n.recipientUserId).sort()).toEqual(
      [harness.ownerUserId, harness.writerUserId].sort(),
    );
    expect(harness.notifications[0]).toMatchObject({
      kind: "integration_auto_sync_paused",
      body: "Auto-sync for ACME paused: alice left the project.",
      payloadJson: {
        integrationId: integration.id,
        reason: "owner_left_project",
        detail: null,
      },
    });
  });

  test("a generic error marks the integration error and keeps the key", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const integration = harness.addJira(key);
    harness.deps.syncJira = () =>
      Promise.reject(new JiraIngestError("Jira returned 500 searching", 500));

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.failed).toBe(1);
    expect(result.paused).toBe(0);
    const failed = harness.current(integration.id);
    expect(failed.status).toBe("error");
    expect(failed.lastError).toBe("Jira returned 500 searching");
    expect(failed.syncSecretId).toBe(key.id);
    expect(harness.released).toEqual([integration.id]);
  });

  test("a Jira 429 skips this tick without pausing or marking error", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const integration = harness.addJira(key);
    harness.deps.syncJira = () =>
      Promise.reject(new JiraIngestError("Jira returned 429", 429));

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result.skippedRateLimited).toBe(1);
    expect(result.failed).toBe(0);
    expect(harness.current(integration.id).status).toBe("active");
    expect(harness.current(integration.id).syncSecretId).toBe(key.id);
  });

  test("one integration failing doesn't stop the others", async () => {
    const harness = createPollHarness();
    const key = await harness.saveJiraKey();
    const failing = harness.addJira(key);
    const rejected = harness.addJira(key);
    const healthy = harness.addJira(key);
    harness.deps.syncJira = (target, credential) => {
      if (target.id === failing.id) {
        return Promise.reject(new Error("boom"));
      }
      if (target.id === rejected.id) {
        return Promise.reject(jiraCredentialRejectedError(credential));
      }
      return Promise.resolve({ totalUpserted: 0, perSource: [] });
    };

    const result = await pollLentKeyIntegrations(harness.deps);

    expect(result).toEqual({
      attempted: 3,
      succeeded: 1,
      failed: 1,
      paused: 1,
      skippedLocked: 0,
      skippedRateLimited: 0,
    });
    expect(harness.current(failing.id).status).toBe("error");
    expect(harness.current(rejected.id).status).toBe("paused");
    expect(harness.current(healthy.id).status).toBe("active");
    expect(new Set(harness.released)).toEqual(
      new Set([failing.id, rejected.id, healthy.id]),
    );
  });
});
