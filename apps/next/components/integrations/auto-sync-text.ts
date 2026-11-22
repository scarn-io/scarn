import type { ProjectIntegrationAutoSyncContract } from "@scarn/core/integrations/project-integration/contracts/project-integration-contracts";
import { formatRelativeTime } from "@/components/executions/format-datetime";
import type { SavedCredentialKind } from "./credential-platforms";

/**
 * Copy for lent-key auto-sync (docs/plans/lent-key-auto-sync.md, "Goal"):
 * the consent text, the status line and the paused message.
 */

export type AutoSyncIntegration =
  | { kind: "jira"; externalScope: { projectKeys: string[] } }
  | { kind: "github_token"; externalScope: { repos: { fullName: string }[] } };

export type AutoSyncPausedReason = NonNullable<
  ProjectIntegrationAutoSyncContract["pausedReason"]
>;

export const autoSyncSecretKind = (
  kind: AutoSyncIntegration["kind"],
): SavedCredentialKind => (kind === "jira" ? "jira_api_key" : "github_token");

const joinWithAnd = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;

export const GITHUB_APP_HINT =
  "Installing the GitHub App is better if you can: it syncs instantly and doesn't use your rate limit.";

export type AutoSyncConsent = { text: string; appHint: string | null };

export const autoSyncConsent = (
  integration: AutoSyncIntegration,
  githubAppConfigured: boolean,
): AutoSyncConsent => {
  if (integration.kind === "jira") {
    return {
      text: `Scarn will read issues from ${integration.externalScope.projectKeys.join(", ")} using your Jira account every 5 minutes. Everyone in this project will see the issues your account can see. Your key is only used for syncing and is never shown to others.`,
      appHint: null,
    };
  }
  const repos = joinWithAnd(
    integration.externalScope.repos.map((repo) => repo.fullName),
  );
  return {
    text: `Scarn will read issues from ${repos} using your GitHub token every 5 minutes. Everyone in this project will see those issues, even if they can't see the repos on GitHub. Syncing uses part of your token's GitHub rate limit. Your token is only used for syncing and is never shown to others.`,
    appHint: githubAppConfigured ? GITHUB_APP_HINT : null,
  };
};

export const autoSyncOnLine = (
  syncsAs: ProjectIntegrationAutoSyncContract["syncsAs"],
  lastSyncedAt: string | null,
): string => {
  const who = syncsAs
    ? ` · as ${syncsAs.displayName ?? "a project member"} (${syncsAs.secretName})`
    : "";
  const when = lastSyncedAt
    ? `last synced ${formatRelativeTime(lastSyncedAt)}`
    : "not synced yet";
  return `Auto-sync on${who} · ${when}`;
};

const PAUSED_REASON_TEXT: Record<AutoSyncPausedReason, string> = {
  key_removed: "the key it synced with was removed.",
  key_rejected: "the key it synced with was rejected.",
  key_expired: "the key it synced with expired.",
  owner_left_project: "the key's owner left this project.",
  access_lost: "the key it synced with lost access.",
};

export const autoSyncPausedLine = (
  reason: AutoSyncPausedReason | null,
): string =>
  reason
    ? `Paused: ${PAUSED_REASON_TEXT[reason]}`
    : "Paused: the key it synced with can no longer be used.";
