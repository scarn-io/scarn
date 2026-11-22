import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  GitHubTokenProjectIntegration,
  JiraProjectIntegration,
} from "@/integrations/project-integration/domain/project-integration-entity";
import {
  autoSyncPausedMessage,
  integrationDisplayName,
} from "@/notifications/user-notification/application/auto-sync-paused-message";

const baseProps = () => ({
  id: createUuidV7(),
  projectId: createUuidV7(),
  status: "active" as const,
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: null,
  syncSecretId: null,
  autoSyncPausedReason: null,
  autoSyncPausedAt: null,
  autoSyncPausedDetail: null,
});

const github = (repos: string[]) =>
  GitHubTokenProjectIntegration.rehydrate({
    ...baseProps(),
    scope: {
      repos: repos.map((fullName, index) => ({ id: index + 1, fullName })),
    },
  });

describe("autoSyncPausedMessage", () => {
  test.each([
    ["key_removed", null, "Alice's key was deleted."],
    ["key_rejected", null, "Alice's key was rejected."],
    ["key_expired", null, "Alice's key has expired."],
    ["owner_left_project", null, "Alice left the project."],
    [
      "access_lost",
      "No access to acme/web",
      "Alice's key lost access. No access to acme/web.",
    ],
  ] as const)("%s", (reason, detail, sentence) => {
    expect(
      autoSyncPausedMessage({
        integrationName: "acme/api",
        ownerName: "Alice",
        reason,
        detail,
      }),
    ).toEqual({
      title: "Auto-sync for acme/api paused",
      body: `Auto-sync for acme/api paused: ${sentence}`,
    });
  });

  test("falls back when the owner's name is unknown", () => {
    expect(
      autoSyncPausedMessage({
        integrationName: "ACME",
        ownerName: null,
        reason: "owner_left_project",
        detail: null,
      }).body,
    ).toBe("Auto-sync for ACME paused: The key's owner left the project.");
    expect(
      autoSyncPausedMessage({
        integrationName: "ACME",
        ownerName: null,
        reason: "key_expired",
        detail: "  ",
      }).body,
    ).toBe("Auto-sync for ACME paused: The lent key has expired.");
  });
});

describe("integrationDisplayName", () => {
  test("names up to two repos, then counts the rest", () => {
    expect(integrationDisplayName(github(["acme/api"]))).toBe("acme/api");
    expect(
      integrationDisplayName(github(["acme/a", "acme/b", "acme/c", "acme/d"])),
    ).toBe("acme/a, acme/b and 2 more");
  });

  test("names Jira project keys", () => {
    expect(
      integrationDisplayName(
        JiraProjectIntegration.rehydrate({
          ...baseProps(),
          scope: {
            baseUrl: "https://acme.atlassian.net",
            projectKeys: ["OPS"],
          },
        }),
      ),
    ).toBe("OPS");
  });
});
