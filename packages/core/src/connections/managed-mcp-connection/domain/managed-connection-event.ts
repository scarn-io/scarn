import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedConnectionReasonCode } from "./managed-connection-entity";
import type { ManagedAuthorityLossReason } from "./managed-launch-connection-entity";
import type { ManagedOAuthAttemptFailureCode } from "./managed-oauth-attempt-entity";

export const managedConnectionEventTypeValues = [
  "connect_started",
  "reconnect_started",
  "attempt_failed",
  "candidate_attached",
  "candidate_confirmed",
  "candidate_cancelled",
  "candidate_expired",
  "reconnect_required",
  "disconnected",
  "revocation_attempted",
  "refresh_succeeded",
  "refresh_failed",
  "refresh_claim_recovered",
  "launch_registered",
  "authority_lost",
] as const;

export type ManagedConnectionEventType =
  (typeof managedConnectionEventTypeValues)[number];

/** Why a refresh failed, recorded as the `refresh_failed` event's reason code. */
export const managedRefreshFailureCodeValues = [
  "refresh_rejected",
  "refresh_client_rejected",
  "refresh_unknown",
  "refresh_server_error",
  "refresh_not_attempted",
] as const;

export type ManagedRefreshFailureCode =
  (typeof managedRefreshFailureCodeValues)[number];

export const managedRevocationOutcomeValues = [
  "accepted",
  "failed",
  "unconfirmed",
] as const;

export type ManagedRevocationOutcome =
  (typeof managedRevocationOutcomeValues)[number];

/**
 * An audit record of something that happened to a managed connection. It
 * carries only IDs, the generation and closed-list codes: never tokens,
 * identity values or anything the provider sent. Launch events
 * (`launch_registered`, `authority_lost`) carry the run's ID but never a
 * relay capability or MCP session ID.
 */
export type ManagedConnectionEvent = {
  id: UuidV7;
  projectId: UuidV7;
  connectionId: UuidV7;
  actorUserId: UuidV7 | null;
  /** The run a launch event is about; null on every other event. */
  taskRunId: UuidV7 | null;
  type: ManagedConnectionEventType;
  generation: number;
  reasonCode:
    | ManagedConnectionReasonCode
    | ManagedOAuthAttemptFailureCode
    | ManagedRefreshFailureCode
    | ManagedAuthorityLossReason
    | null;
  revocationOutcome: ManagedRevocationOutcome | null;
  /**
   * On a confirmation that replaced a grant: whether the new grant acts as the
   * same provider account, or null when either identity is unverified. Null on
   * every other event.
   */
  sameIdentityAsActive: boolean | null;
  createdAt: Date;
};

export type CreateManagedConnectionEventInput = Omit<
  ManagedConnectionEvent,
  | "id"
  | "taskRunId"
  | "reasonCode"
  | "revocationOutcome"
  | "sameIdentityAsActive"
> & {
  taskRunId?: UuidV7 | undefined;
  reasonCode?: ManagedConnectionEvent["reasonCode"] | undefined;
  revocationOutcome?: ManagedRevocationOutcome | undefined;
  sameIdentityAsActive?: boolean | null | undefined;
};

export const createManagedConnectionEvent = (
  input: CreateManagedConnectionEventInput,
): ManagedConnectionEvent => ({
  ...input,
  id: createUuidV7(),
  taskRunId: input.taskRunId ?? null,
  reasonCode: input.reasonCode ?? null,
  revocationOutcome: input.revocationOutcome ?? null,
  sameIdentityAsActive: input.sameIdentityAsActive ?? null,
});
