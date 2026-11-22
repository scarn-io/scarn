import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PlanId } from "@scarn/core/billing/plan/contracts/plan-contracts";
import type { UsageMeter } from "../domain/usage-meter-entity";
import type { OrgRetainedBytes } from "./storage-usage-reader";

export type UsageMeterRepo = {
  /**
   * Loads the persisted meter for an org's billing period, or `null` when no row
   * exists yet. When called inside a transaction (a `dbExecutor` is provided),
   * the row is locked `FOR UPDATE` so a concurrent read-modify-write in another
   * transaction blocks until this one commits — closing the lost-update window
   * that the absolute-value upsert in {@link UsageMeterRepo.save} cannot.
   */
  loadForPeriod(
    orgId: UuidV7,
    period: string,
    dbExecutor?: DbExecutor,
  ): Promise<UsageMeter | null>;

  /**
   * Loads the existing meter or returns a zeroed `UsageMeter.startPeriod(...)`.
   * The fresh meter is NOT persisted — persistence happens on the next
   * {@link UsageMeterRepo.save} after a `record*` mutation.
   */
  loadOrStart(
    orgId: UuidV7,
    period: string,
    planId: PlanId,
    dbExecutor?: DbExecutor,
  ): Promise<UsageMeter>;

  save(meter: UsageMeter, dbExecutor?: DbExecutor): Promise<UsageMeter>;

  /**
   * Set-based storage reconciliation for a billing `period`. In a fixed number
   * of statements (independent of org count) it makes every meter row's
   * `storageBytes` reflect the recomputed source-of-truth retained total:
   *
   *  - Every org listed in `retainedByOrg` has its `storageBytes` SET to that
   *    absolute byte total (a snapshot overwrite, matching
   *    {@link UsageMeter.withStorageBytes}). A meter row is inserted with
   *    `defaultPlanId` and zeroed `writes`/`reads` when the org has retained
   *    bytes but no row for the period yet.
   *  - Every OTHER meter row in the period is floored to `storageBytes = 0`
   *    (these are orgs whose archives all expired; the source-of-truth sum omits
   *    them, so they must be zeroed explicitly).
   *
   * `writes`/`reads` are never touched — they are independent monthly FLOW
   * counters. This replaces the former per-org read-modify-write loop, which
   * issued O(orgs) round-trips inside the reconciliation transaction.
   *
   * Returns the number of orgs whose storage was reconciled (rows set + rows
   * floored to zero).
   *
   * With `orgId`, only that org's meter row is floored ("every other row"
   * means only that org's, if it isn't retained).
   */
  reconcileStorageForPeriod(
    period: string,
    retainedByOrg: OrgRetainedBytes[],
    defaultPlanId: PlanId,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number>;
};
