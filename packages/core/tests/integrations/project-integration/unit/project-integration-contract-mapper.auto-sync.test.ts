import { describe, expect, test } from "bun:test";
import {
  BitbucketProjectIntegration,
  JiraProjectIntegration,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { projectIntegrationEntityToContract } from "@/integrations/project-integration/application/project-integration-contract-mapper";
import { loadAutoSyncDisplay } from "@/integrations/project-integration/application/load-auto-sync-display";
import { projectIntegrationSchema } from "@/integrations/project-integration/contracts/project-integration-contracts";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const now = new Date("2026-11-04T12:00:00.000Z");
const AUTO_SYNC_KEYS = [
  "pausedAt",
  "pausedDetail",
  "pausedReason",
  "state",
  "supported",
  "syncsAs",
];

const jira = () =>
  JiraProjectIntegration.create({
    projectId,
    scope: { baseUrl: "https://acme.atlassian.net", projectKeys: ["ACME"] },
  });

describe("projectIntegrationEntityToContract autoSync", () => {
  test("off when no key is lent", () => {
    const contract = projectIntegrationEntityToContract(jira(), now);

    expect(Object.keys(contract.autoSync).sort()).toEqual(AUTO_SYNC_KEYS);
    expect(contract.autoSync).toEqual({
      supported: true,
      state: "off",
      syncsAs: null,
      pausedReason: null,
      pausedDetail: null,
      pausedAt: null,
    });
    expect(projectIntegrationSchema.safeParse(contract).success).toBe(true);
  });

  test("on with who it syncs as, carrying no key material", async () => {
    const secretId = createUuidV7();
    const ownerUserId = createUuidV7();
    const integration = jira().withAutoSync(secretId);
    const display = await loadAutoSyncDisplay([integration], {
      secretRepo: {
        listSummariesByIds: (ids) =>
          Promise.resolve(
            ids.includes(secretId)
              ? [{ id: secretId, name: "Team Jira key", ownerUserId }]
              : [],
          ),
      },
      usernameReader: {
        loadUsernamesByUserId: () =>
          Promise.resolve(
            new Map([[ownerUserId, { username: "dwight", image: null }]]),
          ),
      },
    });

    const contract = projectIntegrationEntityToContract(
      integration,
      now,
      display,
    );

    expect(Object.keys(contract.autoSync).sort()).toEqual(AUTO_SYNC_KEYS);
    expect(contract.autoSync).toEqual({
      supported: true,
      state: "on",
      syncsAs: {
        userId: ownerUserId,
        displayName: "dwight",
        secretName: "Team Jira key",
      },
      pausedReason: null,
      pausedDetail: null,
      pausedAt: null,
    });
    expect(Object.keys(contract.autoSync.syncsAs ?? {}).sort()).toEqual([
      "displayName",
      "secretName",
      "userId",
    ]);
    expect(projectIntegrationSchema.safeParse(contract).success).toBe(true);
  });

  test("on with syncsAs null when the key's summary is not in the lookup", () => {
    const contract = projectIntegrationEntityToContract(
      jira().withAutoSync(createUuidV7()),
      now,
    );
    expect(contract.autoSync.state).toBe("on");
    expect(contract.autoSync.syncsAs).toBeNull();
  });

  test("paused with its reason, detail and time", () => {
    const pausedAt = new Date("2026-11-03T08:00:00.000Z");
    const contract = projectIntegrationEntityToContract(
      jira()
        .withAutoSync(createUuidV7())
        .withAutoSyncPaused("key_rejected", pausedAt, "401 from Jira"),
      now,
    );

    expect(contract.status).toBe("paused");
    expect(contract.autoSync).toEqual({
      supported: true,
      state: "paused",
      syncsAs: null,
      pausedReason: "key_rejected",
      pausedDetail: "401 from Jira",
      pausedAt: pausedAt.toISOString(),
    });
  });

  test("unsupported kinds report supported: false", () => {
    const contract = projectIntegrationEntityToContract(
      BitbucketProjectIntegration.create({
        projectId,
        scope: {
          repos: [{ workspace: "team", slug: "api", fullName: "team/api" }],
        },
      }),
      now,
    );
    expect(contract.autoSync.supported).toBe(false);
    expect(contract.autoSync.state).toBe("off");
  });
});
