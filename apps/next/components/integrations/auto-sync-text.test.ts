import { describe, expect, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  GITHUB_APP_HINT,
  autoSyncConsent,
  autoSyncOnLine,
  autoSyncPausedLine,
  autoSyncSecretKind,
} from "./auto-sync-text";

const jira = {
  kind: "jira" as const,
  externalScope: { projectKeys: ["ACME", "WEB"] },
};

const github = {
  kind: "github_token" as const,
  externalScope: {
    repos: [{ fullName: "acme/api" }, { fullName: "acme/web" }],
  },
};

describe("autoSyncConsent", () => {
  test("Jira names the project keys and never adds the App hint", () => {
    expect(autoSyncConsent(jira, true)).toEqual({
      text: "Scarn will read issues from ACME, WEB using your Jira account every 5 minutes. Everyone in this project will see the issues your account can see. Your key is only used for syncing and is never shown to others.",
      appHint: null,
    });
  });

  test("GitHub names the repos and adds the App hint when the App is configured", () => {
    expect(autoSyncConsent(github, true)).toEqual({
      text: "Scarn will read issues from acme/api and acme/web using your GitHub token every 5 minutes. Everyone in this project will see those issues, even if they can't see the repos on GitHub. Syncing uses part of your token's GitHub rate limit. Your token is only used for syncing and is never shown to others.",
      appHint:
        "Installing the GitHub App is better if you can: it syncs instantly and doesn't use your rate limit.",
    });
    expect(GITHUB_APP_HINT).toContain("GitHub App");
  });

  test("GitHub leaves out the App hint when no App is configured", () => {
    expect(autoSyncConsent(github, false).appHint).toBeNull();
  });

  test("lists three repos with commas and a final 'and'", () => {
    const three = {
      ...github,
      externalScope: {
        repos: [...github.externalScope.repos, { fullName: "acme/cli" }],
      },
    };
    expect(autoSyncConsent(three, false).text).toStartWith(
      "Scarn will read issues from acme/api, acme/web and acme/cli using",
    );
  });
});

describe("autoSyncOnLine", () => {
  test("names who it syncs as, the key and when it last synced", () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(
      autoSyncOnLine(
        {
          userId: parseUuidV7("0198f2c4-0000-7000-8000-000000000001"),
          displayName: "Alice",
          secretName: "Work Jira",
        },
        twoMinutesAgo,
      ),
    ).toBe("Auto-sync on · as Alice (Work Jira) · last synced 2 minutes ago");
  });

  test("says when it hasn't synced yet", () => {
    expect(autoSyncOnLine(null, null)).toBe("Auto-sync on · not synced yet");
  });
});

describe("autoSyncPausedLine", () => {
  test.each([
    ["key_removed", "Paused: the key it synced with was removed."],
    ["key_rejected", "Paused: the key it synced with was rejected."],
    ["key_expired", "Paused: the key it synced with expired."],
    ["owner_left_project", "Paused: the key's owner left this project."],
    ["access_lost", "Paused: the key it synced with lost access."],
  ] as const)("%s", (reason, text) => {
    expect(autoSyncPausedLine(reason)).toBe(text);
  });
});

test("each integration kind lends its own key kind", () => {
  expect(autoSyncSecretKind("jira")).toBe("jira_api_key");
  expect(autoSyncSecretKind("github_token")).toBe("github_token");
});
