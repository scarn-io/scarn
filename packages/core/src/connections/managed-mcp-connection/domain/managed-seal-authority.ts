/**
 * The authority fence's decision (decisions 3, 4, 15, 16): whether a run may
 * seal (complete or yield) given each open launch connection, the connection
 * it pinned, that connection's serving grant and the run's leased
 * operations.
 *
 * Precedence, first match wins:
 * 1. authority loss: a launch whose connection is gone or no longer serves
 *    its pinned generation and grant (`disconnected`, `replaced`,
 *    `reconnect_required`), or an operation still leased past its deadline
 *    (`operation_unknown`). The run fails; nothing it reported applies.
 * 2. an operation still in flight: the seal waits (`MANAGED_OPERATION_IN_FLIGHT`).
 * 3. a refresh claim, fresh or stale, on a pinned serving grant: the seal
 *    waits (`MANAGED_CONNECTION_REFRESH_PENDING`) until the refresh commits
 *    or is recovered, which turns it into a loss.
 *
 * Loss beats waiting because waiting can't restore authority that has
 * already moved.
 */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { joinConnectionLabels } from "./managed-connection-labels";
import type { ManagedConnectionEntity } from "./managed-connection-entity";
import type {
  ManagedAuthorityLossReason,
  ManagedLaunchConnectionEntity,
  ManagedOperation,
} from "./managed-launch-connection-entity";
import type { ManagedOAuthGrantEntity } from "./managed-oauth-grant-entity";

/** The Task error name of a run the authority fence failed. */
export const MANAGED_CONNECTION_AUTHORITY_LOST =
  "ManagedConnectionAuthorityLost";

/**
 * How to start a new attempt after a managed connection failure, which is
 * never retried automatically (decision 5).
 */
export const MANAGED_NEW_ATTEMPT_GUIDANCE =
  "It isn't retried automatically: start a new attempt explicitly with Retry in the app, `scarn tasks retry <taskId>`, or `scarn runs rerun <runId> --step <key>` for a pipeline step.";

/** Why a seal must wait and be retried: nothing has failed yet. */
export const managedSealBlockCodeValues = [
  "MANAGED_OPERATION_IN_FLIGHT",
  "MANAGED_CONNECTION_REFRESH_PENDING",
] as const;

export type ManagedSealBlockCode = (typeof managedSealBlockCodeValues)[number];

/** One open launch connection with what it is checked against, read under the connection's lock. */
export type ManagedSealAuthorityCheck = {
  launch: ManagedLaunchConnectionEntity;
  /** Null when the connection row no longer exists. */
  connection: ManagedConnectionEntity | null;
  /** The connection's serving grant; only read when the launch is still authorized. */
  servingGrant: Pick<ManagedOAuthGrantEntity, "refreshClaim"> | null;
};

export type ManagedAuthorityLoss = {
  launchConnectionId: UuidV7;
  connectionId: UuidV7;
  /** The connection's label; null when its row no longer exists. */
  label: string | null;
  reason: ManagedAuthorityLossReason;
};

export type ManagedSealAuthorityDecision =
  | { kind: "authorized" }
  | { kind: "lost"; losses: ManagedAuthorityLoss[] }
  | { kind: "blocked"; code: ManagedSealBlockCode };

const pinnedAuthorityLoss = (
  check: ManagedSealAuthorityCheck,
): ManagedAuthorityLossReason | null =>
  check.connection === null
    ? "disconnected"
    : check.launch.authorityLossReason(check.connection);

/** See the module doc for the rules and their precedence. */
export const decideSealAuthority = (
  checks: readonly ManagedSealAuthorityCheck[],
  operations: readonly Pick<
    ManagedOperation,
    "launchConnectionId" | "deadlineAt"
  >[],
  now: Date,
): ManagedSealAuthorityDecision => {
  const losses: ManagedAuthorityLoss[] = [];
  for (const check of checks) {
    const lapsed = operations.some(
      (operation) =>
        operation.launchConnectionId === check.launch.id &&
        operation.deadlineAt.getTime() <= now.getTime(),
    );
    const reason =
      pinnedAuthorityLoss(check) ?? (lapsed ? "operation_unknown" : null);
    if (reason !== null) {
      losses.push({
        launchConnectionId: check.launch.id,
        connectionId: check.launch.connectionId,
        label: check.connection?.label ?? null,
        reason,
      });
    }
  }
  if (losses.length > 0) {
    return { kind: "lost", losses };
  }
  if (operations.length > 0) {
    return { kind: "blocked", code: "MANAGED_OPERATION_IN_FLIGHT" };
  }
  if (checks.some((check) => check.servingGrant?.refreshClaim)) {
    return { kind: "blocked", code: "MANAGED_CONNECTION_REFRESH_PENDING" };
  }
  return { kind: "authorized" };
};

const lostChanges = (losses: readonly ManagedAuthorityLoss[]): string => {
  const joined = joinConnectionLabels(losses.map((loss) => loss.label));
  return joined === null
    ? "Changes in the connected services"
    : `${joined.text} changes`;
};

/**
 * The named error (see `namedRunError`) of a run the fence failed, naming
 * the lost connections by label. With several losses the first, in
 * entry-key order, names the reason.
 */
export const managedAuthorityLostError = (
  losses: readonly ManagedAuthorityLoss[],
): { name: string; message: string; cause: AnyJsonValue } => ({
  name: MANAGED_CONNECTION_AUTHORITY_LOST,
  message: `A managed connection this run used was disconnected, replaced or needs reconnecting before the run finished, so its outcome wasn't applied. ${MANAGED_NEW_ATTEMPT_GUIDANCE} ${lostChanges(losses)} the failed attempt already made may remain, and a new attempt may repeat them.`,
  cause: { reason: losses[0]?.reason ?? "disconnected" },
});

/** Whether a run's named error is the fence's `ManagedConnectionAuthorityLost`. */
export const isManagedConnectionAuthorityLost = (error: {
  name: string;
}): boolean => error.name === MANAGED_CONNECTION_AUTHORITY_LOST;
