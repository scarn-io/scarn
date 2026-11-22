import type { ManagedConnectionEntity } from "./managed-connection-entity";
import { MANAGED_OAUTH_ATTEMPT_TTL_MS } from "./managed-oauth-attempt-entity";
import type { ManagedOAuthGrantEntity } from "./managed-oauth-grant-entity";

/** How long retired grants and connection events are kept (decision 11). */
export const MANAGED_CONNECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** When a candidate grant stops being confirmable: 10 minutes after the callback stored it. */
export const managedCandidateExpiresAt = (
  grant: ManagedOAuthGrantEntity,
): Date => new Date(grant.createdAt.getTime() + MANAGED_OAUTH_ATTEMPT_TTL_MS);

const connectLapsed = (connection: ManagedConnectionEntity, now: Date) =>
  connection.state === "connecting" &&
  now.getTime() >=
    connection.updatedAt.getTime() + MANAGED_OAUTH_ATTEMPT_TTL_MS;

const candidateLapsed = (
  candidate: ManagedOAuthGrantEntity | null,
  now: Date,
) =>
  candidate !== null &&
  now.getTime() >= managedCandidateExpiresAt(candidate).getTime();

/**
 * What `connection` has become by `now` if nobody acted in time: a first
 * connect whose attempt window passed, or a candidate (`candidate`, the grant
 * at `connection.pendingCandidateGrantId`) left unconfirmed past its window,
 * moves through `expire`. Null while nothing has lapsed. Pure, so reads can
 * show a lapsed connection as expired without writing it.
 */
export const lapseManagedConnection = (
  connection: ManagedConnectionEntity,
  candidate: ManagedOAuthGrantEntity | null,
  now: Date,
): {
  connection: ManagedConnectionEntity;
  candidateExpired: boolean;
} | null => {
  const candidateExpired = candidateLapsed(candidate, now);
  if (!candidateExpired && !connectLapsed(connection, now)) {
    return null;
  }
  return { connection: connection.expire(now), candidateExpired };
};
