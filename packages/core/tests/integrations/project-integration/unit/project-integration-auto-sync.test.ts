import { describe, expect, test } from "bun:test";
import {
  AUTO_SYNC_SECRET_KIND,
  GitHubAppProjectIntegration,
  ProjectIntegrationEntity,
  supportsAutoSync,
  type ProjectIntegrationKind,
  type ProjectIntegrationRowProps,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const secretId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f03");
const otherSecretId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f04");
const pausedAt = new Date("2026-11-01T12:00:00Z");

const jira = () =>
  ProjectIntegrationEntity.create({
    kind: "jira",
    projectId,
    scope: { baseUrl: "https://acme.atlassian.net", projectKeys: ["ACME"] },
  });

const errorCode = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (caught: unknown) {
    if (caught instanceof CoreValidationError) return caught.code;
    throw caught;
  }
  return null;
};

const githubRepoScope = { repos: [{ id: 1, fullName: "acme/repo" }] };

const rowFor = (
  kind: ProjectIntegrationKind,
  syncSecretId: ProjectIntegrationRowProps["syncSecretId"],
): ProjectIntegrationRowProps => ({
  id: createUuidV7(),
  projectId,
  kind,
  installationId: kind === "github_app" ? "123" : null,
  externalScopeJson:
    kind === "jira"
      ? { baseUrl: "https://acme.atlassian.net", projectKeys: ["ACME"] }
      : kind === "bitbucket"
        ? { repos: [{ workspace: "acme", slug: "api", fullName: "acme/api" }] }
        : githubRepoScope,
  status: "active",
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: null,
  syncSecretId,
  autoSyncPausedReason: null,
  autoSyncPausedAt: null,
  autoSyncPausedDetail: null,
});

describe("auto-sync transitions", () => {
  test("a new integration has auto-sync off", () => {
    const integration = jira();
    expect(integration.syncSecretId).toBeNull();
    expect(integration.autoSyncPausedReason).toBeNull();
    expect(integration.autoSyncPausedAt).toBeNull();
    expect(integration.autoSyncPausedDetail).toBeNull();
  });

  test("withAutoSync sets the key and leaves no pause", () => {
    const integration = jira().withAutoSync(secretId);
    expect(integration.syncSecretId).toBe(secretId);
    expect(integration.status).toBe("active");
    expect(integration.autoSyncPausedReason).toBeNull();
    expect(integration.autoSyncPausedAt).toBeNull();
    expect(integration.autoSyncPausedDetail).toBeNull();
  });

  test("withAutoSyncOff clears the key with no reason", () => {
    const integration = jira().withAutoSync(secretId).withAutoSyncOff();
    expect(integration.syncSecretId).toBeNull();
    expect(integration.status).toBe("active");
    expect(integration.autoSyncPausedReason).toBeNull();
    expect(integration.autoSyncPausedAt).toBeNull();
    expect(integration.autoSyncPausedDetail).toBeNull();
  });

  test("withAutoSyncPaused clears the key and records status, reason, time and detail", () => {
    const integration = ProjectIntegrationEntity.create({
      kind: "github_token",
      projectId,
      scope: githubRepoScope,
    })
      .withAutoSync(secretId)
      .withAutoSyncPaused("access_lost", pausedAt, "acme/repo");
    expect(integration.syncSecretId).toBeNull();
    expect(integration.status).toBe("paused");
    expect(integration.autoSyncPausedReason).toBe("access_lost");
    expect(integration.autoSyncPausedAt).toEqual(pausedAt);
    expect(integration.autoSyncPausedDetail).toBe("acme/repo");
  });

  test("withAutoSyncPaused defaults the detail to null", () => {
    const integration = jira()
      .withAutoSync(secretId)
      .withAutoSyncPaused("key_rejected", pausedAt);
    expect(integration.autoSyncPausedDetail).toBeNull();
  });

  test("withAutoSync after a pause clears the reason, time and detail", () => {
    const integration = jira()
      .withAutoSync(secretId)
      .withAutoSyncPaused("key_expired", pausedAt, "expired yesterday")
      .withAutoSync(otherSecretId);
    expect(integration.syncSecretId).toBe(otherSecretId);
    expect(integration.status).toBe("active");
    expect(integration.autoSyncPausedReason).toBeNull();
    expect(integration.autoSyncPausedAt).toBeNull();
    expect(integration.autoSyncPausedDetail).toBeNull();
  });

  test("withAutoSyncOff after a pause clears the pause too", () => {
    const integration = jira()
      .withAutoSync(secretId)
      .withAutoSyncPaused("owner_left_project", pausedAt)
      .withAutoSyncOff();
    expect(integration.status).toBe("active");
    expect(integration.autoSyncPausedReason).toBeNull();
  });

  test("turning auto-sync on keeps an error status", () => {
    const integration = jira()
      .withSyncError("boom", pausedAt)
      .withAutoSync(secretId);
    expect(integration.status).toBe("error");
  });

  test("auto-sync fields survive toJSON and rehydrate", () => {
    const paused = jira()
      .withAutoSync(secretId)
      .withAutoSyncPaused("key_removed", pausedAt, "detail");
    const restored = ProjectIntegrationEntity.rehydrate(paused.toJSON());
    expect(restored.toJSON()).toEqual(paused.toJSON());
  });
});

describe("auto-sync kind check", () => {
  test("AUTO_SYNC_SECRET_KIND maps jira and github_token only", () => {
    expect(AUTO_SYNC_SECRET_KIND).toEqual({
      jira: "jira_api_key",
      github_token: "github_token",
    });
  });

  test.each([
    ["jira", true],
    ["github_token", true],
    ["github_app", false],
    ["bitbucket", false],
  ] as const)("supportsAutoSync(%s) is %p", (kind, expected) => {
    expect(
      supportsAutoSync(ProjectIntegrationEntity.rehydrate(rowFor(kind, null))),
    ).toBe(expected);
  });

  test.each(["jira", "github_token"] as const)(
    "%s accepts a lent key",
    (kind) => {
      const integration = ProjectIntegrationEntity.rehydrate(
        rowFor(kind, secretId),
      );
      expect(integration.syncSecretId).toBe(secretId);
    },
  );

  test.each(["github_app", "bitbucket"] as const)(
    "%s rejects a lent key",
    (kind) => {
      expect(
        errorCode(() =>
          ProjectIntegrationEntity.rehydrate(rowFor(kind, secretId)),
        ),
      ).toBe("PROJECT_INTEGRATION_AUTO_SYNC_UNSUPPORTED");
    },
  );

  test("withAutoSync on an unsupported kind is rejected", () => {
    const integration = GitHubAppProjectIntegration.create({
      projectId,
      installationId: "123",
      scope: githubRepoScope,
    });
    expect(errorCode(() => integration.withAutoSync(secretId))).toBe(
      "PROJECT_INTEGRATION_AUTO_SYNC_UNSUPPORTED",
    );
  });
});
