import type {
  ManagedConnectionAccountContract,
  ManagedConnectionContract,
  ManagedOAuthCallbackError,
} from "@scarn/api/frontend-contracts";

type RevocationOutcome = NonNullable<
  ManagedConnectionContract["lastRevocation"]
>["outcome"];

const REVOCATION_SEVERITIES: Record<RevocationOutcome, "success" | "warning"> =
  {
    accepted: "success",
    failed: "warning",
    unconfirmed: "warning",
  };

/** What the service `label` said about Scarn's revocation request. */
export const revocationMessage = (
  outcome: RevocationOutcome,
  label: string,
): { severity: "success" | "warning"; text: string } => {
  const text = {
    accepted: `${label} accepted Scarn's request to revoke this connection's access.`,
    failed: `${label} refused Scarn's request to revoke this connection's access, so Scarn can't confirm it was revoked.`,
    unconfirmed: `${label} didn't answer Scarn's request to revoke this connection's access, so Scarn can't confirm it was revoked.`,
  }[outcome];
  return { severity: REVOCATION_SEVERITIES[outcome], text };
};

/**
 * What the OAuth callback's `?error=<code>` means, in words. The callback
 * names no connection, so these don't name a service. Typed against the full
 * code list so a new code can't ship without a message.
 */
const CALLBACK_ERROR_MESSAGES: Record<ManagedOAuthCallbackError, string> = {
  access_denied: "Access wasn't granted, so nothing was connected.",
  provider_error:
    "The service couldn't complete the authorization. Try connecting again.",
  invalid_callback:
    "The service's response couldn't be verified, so it was discarded. Start again from this page.",
  exchange_failed:
    "Scarn couldn't finish connecting to the service. Try connecting again.",
  exchange_unknown:
    "Scarn couldn't tell whether the service finished connecting, so nothing was saved. Try connecting again.",
  missing_refresh:
    "The service didn't grant long-lived access, so nothing was saved. Try connecting again.",
  missing_expiry:
    "The service didn't say when the access expires, so nothing was saved. Try connecting again.",
  missing_identity:
    "The service didn't say which account was connected, so nothing was saved. Try connecting again.",
  client_configuration:
    "The service rejected Scarn's app configuration. Ask your Scarn administrator to check the connection setup.",
  stale_generation:
    "The connection changed while you were away authorizing it, so this authorization was discarded. Start again from this page.",
  permission_revoked:
    "You no longer have permission to manage this project's connections, so nothing was saved.",
  attempt_expired:
    "The authorization took longer than 10 minutes and expired. Start again from this page.",
};

export const isManagedOAuthCallbackError = (
  value: string,
): value is ManagedOAuthCallbackError =>
  Object.hasOwn(CALLBACK_ERROR_MESSAGES, value);

export const managedOAuthCallbackErrorMessage = (
  code: ManagedOAuthCallbackError,
): string => CALLBACK_ERROR_MESSAGES[code];

/** Why connection `label` is in its state, or null when there's no reason code. */
export const managedConnectionReasonMessage = (
  reasonCode: ManagedConnectionContract["reasonCode"],
  label: string,
): string | null => {
  if (!reasonCode) return null;
  return {
    attempt_expired:
      "The last authorization attempt expired before it finished.",
    candidate_expired:
      "The last connection wasn't confirmed within 10 minutes, so it was discarded.",
    candidate_cancelled:
      "The last connection was cancelled before it was used.",
    refresh_failed: `${label} stopped accepting this connection. Reconnect to keep using it.`,
    grant_expired: `This connection's access to ${label} has expired.`,
    client_configuration: `${label} rejected Scarn's app configuration. Ask your Scarn administrator to check the ${label} connection setup.`,
  }[reasonCode];
};

export const STATE_LABELS: Record<ManagedConnectionContract["state"], string> =
  {
    disconnected: "Not connected",
    connecting: "Waiting for authorization",
    awaiting_confirmation: "Waiting for confirmation",
    ready: "Connected",
    ready_with_pending_reconnect: "Connected, reconnect in progress",
    reconnect_required: "Reconnect required",
  };

/**
 * Who a grant acts as, from the names connection `label`'s server gave. A
 * server that names nobody (a preset without an identity parser) reads as
 * an unidentified account.
 */
export const managedConnectionAccountLine = (
  account: ManagedConnectionAccountContract,
  label: string,
) => {
  const { userName, workspaceName } = account;
  if (userName === null && workspaceName === null) {
    return `Connected to ${label} with an unidentified account`;
  }
  const user = userName ?? `an unnamed ${label} user`;
  return workspaceName === null
    ? `Connected as ${user}`
    : `Connected as ${user} in ${workspaceName}`;
};

/**
 * One-line status for a connection as a step referencing it sees it: the
 * account while it serves runs, otherwise the state label. A missing
 * connection reads as not connected.
 */
export const managedConnectionStatusLine = (
  connection: ManagedConnectionContract | null,
): string => {
  if (!connection) return STATE_LABELS.disconnected;
  const serving =
    connection.state === "ready" ||
    connection.state === "ready_with_pending_reconnect";
  if (serving && connection.account) {
    return managedConnectionAccountLine(connection.account, connection.label);
  }
  return STATE_LABELS[connection.state];
};

export const sharedAuthorityDisclosure = (label: string) =>
  `Anyone who can run steps in this project will be able to act in ${label} as this account.`;

/** The command that signs a connection with a supplied client in again. */
export const cliReconnectCommand = (name: string) =>
  `scarn connections reconnect ${name}`;
