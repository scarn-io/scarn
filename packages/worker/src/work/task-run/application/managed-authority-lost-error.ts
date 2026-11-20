import type { ManagedAuthorityLossReason } from "../contracts/task-run-contracts";

/** Error code reported when a run lost a managed connection's authority. */
export const MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_CODE =
  "MANAGED_CONNECTION_AUTHORITY_LOST";

/**
 * The Task error name the server gives a run that lost a managed
 * connection's authority; the server never retries it.
 */
export const MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_NAME =
  "ManagedConnectionAuthorityLost";

/**
 * Why the worker aborted a run for lost managed authority: a reason the
 * server's heartbeat reported, or `control_lost` when no heartbeat was
 * accepted for a whole lease, so the server stopped relaying the run's calls.
 */
export type ManagedAuthorityAbortReason =
  | ManagedAuthorityLossReason
  | "control_lost";

/**
 * Thrown when the run was aborted with the `managed_authority_lost` reason.
 * Unlike `TaskRunCancelledError`, the run is reported as failed with
 * {@link MANAGED_CONNECTION_AUTHORITY_LOST_ERROR_NAME} and the reason as its
 * `cause`.
 */
export class ManagedAuthorityLostError extends Error {
  readonly reason: ManagedAuthorityAbortReason;

  constructor(taskRunId: string, reason: ManagedAuthorityAbortReason) {
    super(
      reason === "control_lost"
        ? `Task run ${taskRunId} was stopped because the worker lost contact with Scarn for a whole lease while it used a managed connection.`
        : `Task run ${taskRunId} was stopped because a managed connection it used lost its authority (${reason}).`,
    );
    this.name = "ManagedAuthorityLostError";
    this.reason = reason;
  }
}
