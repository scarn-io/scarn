import { assertNever } from "@scarn/core/lib/assert-never";
import type {
  AutoSyncPausedReason,
  ProjectIntegrationEntity,
} from "@scarn/core/integrations/project-integration/domain/project-integration-entity";

const MAX_NAMED_SCOPES = 2;

const listNames = (names: readonly string[]): string => {
  const named = names.slice(0, MAX_NAMED_SCOPES).join(", ");
  const rest = names.length - MAX_NAMED_SCOPES;
  return rest > 0 ? `${named} and ${String(rest)} more` : named;
};

/**
 * How people recognise an integration: its repos (GitHub, Bitbucket) or
 * Jira project keys, which every scope has at least one of.
 */
export const integrationDisplayName = (
  integration: ProjectIntegrationEntity,
): string => {
  const scopeNames =
    integration.kind === "jira"
      ? integration.scope.projectKeys
      : integration.scope.repos.map((repo) => repo.fullName);
  return listNames(scopeNames);
};

export type AutoSyncPausedMessageInput = {
  integrationName: string;
  /** The key owner's username; null when unknown. */
  ownerName: string | null;
  reason: AutoSyncPausedReason;
  detail: string | null;
};

const reasonSentence = (
  reason: AutoSyncPausedReason,
  ownerName: string | null,
): string => {
  const key = ownerName === null ? "The lent key" : `${ownerName}'s key`;
  switch (reason) {
    case "key_removed":
      return `${key} was deleted`;
    case "key_rejected":
      return `${key} was rejected`;
    case "key_expired":
      return `${key} has expired`;
    case "owner_left_project":
      return ownerName === null
        ? "The key's owner left the project"
        : `${ownerName} left the project`;
    case "access_lost":
      return `${key} lost access`;
    default:
      return assertNever(reason);
  }
};

/**
 * The title and body of an `integration_auto_sync_paused` notification, e.g.
 * "Auto-sync for acme/api paused: Alice's key lost access. No access to
 * acme/web." Built only from names and the pause detail, never from a key
 * value, its last four or an email.
 */
export const autoSyncPausedMessage = (
  input: AutoSyncPausedMessageInput,
): { title: string; body: string } => {
  const title = `Auto-sync for ${input.integrationName} paused`;
  const detail = input.detail?.trim().replace(/\.+$/, "") ?? "";
  const sentence = `${reasonSentence(input.reason, input.ownerName)}.`;
  return {
    title,
    body: `${title}: ${detail.length > 0 ? `${sentence} ${detail}.` : sentence}`,
  };
};
