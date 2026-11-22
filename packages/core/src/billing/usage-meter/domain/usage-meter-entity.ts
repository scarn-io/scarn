import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreValidationError,
  UsageLimitExceededError,
  type UsageLimitKind,
} from "@scarn/core/lib/errors";
import { PlanLimits } from "@scarn/core/billing/plan/domain/plan-limits";
import {
  planIdSchema,
  type PlanId,
} from "@scarn/core/billing/plan/contracts/plan-contracts";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type UsageMeterProps = {
  orgId: UuidV7;
  period: string;
  planId: PlanId;
  writes: number;
  reads: number;
  storageBytes: number;
  signalTokens: number;
};

const assertCount = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new CoreValidationError(
      `Usage meter ${field} must be a non-negative integer`,
      "INVALID_USAGE_COUNT",
    );
  }

  return value;
};

/**
 * `UsageMeter` is the aggregate root for per-org, per-calendar-month usage
 * metering. ALL quota logic lives here: query methods (`can*`) answer "is there
 * headroom?" without mutating, and command methods (`record*`) enforce the cap
 * and produce the next state.
 *
 * Mutability: the codebase is uniformly immutable — every entity (e.g.
 * `ProjectEntity`, `TaskRunEntity`) keeps `public readonly` props and
 * returns a new instance from `with*`/transition methods rather than mutating in
 * place. We match that idiom: `record*` returns a NEW `UsageMeter`; the caller
 * reassigns and persists it.
 *
 * Domain events: the repo does NOT use a `pullDomainEvents`/buffer pattern;
 * use cases construct and publish events directly (see `create-project.ts`).
 * We therefore do not buffer events on the entity. Instead, the meter returned
 * by a `record*` call exposes {@link UsageMeter.limitReached} describing whether
 * THIS record crossed a cap (reached 100%). The Phase 3 use case reads that flag
 * and publishes a `UsageLimitReachedDomainEvent` via the dispatcher.
 */
export class UsageMeter {
  public readonly orgId: UuidV7;
  public readonly period: string;
  public readonly planId: PlanId;
  public readonly writes: number;
  public readonly reads: number;
  public readonly storageBytes: number;
  public readonly signalTokens: number;

  private readonly limits: PlanLimits;

  /**
   * Non-persisted flag describing whether the `record*` call that produced this
   * instance caused a counter to reach/exceed its cap. `null` on instances built
   * via `startPeriod`/`rehydrate`.
   */
  public readonly limitReached: UsageLimitKind | null;

  private constructor(
    props: UsageMeterProps,
    limitReached: UsageLimitKind | null,
  ) {
    if (!PERIOD_PATTERN.test(props.period)) {
      throw new CoreValidationError(
        `Usage meter period must be "YYYY-MM": ${props.period}`,
        "INVALID_USAGE_PERIOD",
      );
    }

    this.orgId = parseUuidV7(props.orgId);
    this.period = props.period;
    this.planId = planIdSchema.parse(props.planId);
    this.writes = assertCount(props.writes, "writes");
    this.reads = assertCount(props.reads, "reads");
    this.storageBytes = assertCount(props.storageBytes, "storageBytes");
    this.signalTokens = assertCount(props.signalTokens, "signalTokens");
    this.limits = PlanLimits.for(this.planId);
    this.limitReached = limitReached;
  }

  static startPeriod(
    orgId: UuidV7,
    period: string,
    planId: PlanId,
  ): UsageMeter {
    return new UsageMeter(
      {
        orgId,
        period,
        planId,
        writes: 0,
        reads: 0,
        storageBytes: 0,
        signalTokens: 0,
      },
      null,
    );
  }

  static rehydrate(props: UsageMeterProps): UsageMeter {
    return new UsageMeter(props, null);
  }

  // --- Queries (no mutation) -------------------------------------------------

  canRecordWrite(): boolean {
    return this.limits.allowsWrite(this.writes);
  }

  canRecordRead(): boolean {
    return this.limits.allowsRead(this.reads);
  }

  canStore(addBytes: number): boolean {
    return this.limits.allowsBytes(this.storageBytes, addBytes);
  }

  canRecordSignalToken(): boolean {
    return this.limits.allowsSignalToken(this.signalTokens);
  }

  // --- Commands (enforce + produce next state) -------------------------------

  /**
   * Records a single write. Throws {@link UsageLimitExceededError} (kind
   * "write") when no headroom remains. Returns a new meter; `limitReached` is
   * "write" when this write brought writes to the cap.
   */
  recordWrite(): UsageMeter {
    if (!this.canRecordWrite()) {
      throw new UsageLimitExceededError("write", {
        orgId: this.orgId,
        period: this.period,
      });
    }

    const writes = this.writes + 1;
    const reached = this.limits.reachedWrites(writes) ? "write" : null;
    return new UsageMeter({ ...this.toJSON(), writes }, reached);
  }

  /**
   * Records a single read. Symmetric with {@link UsageMeter.recordWrite}.
   */
  recordRead(): UsageMeter {
    if (!this.canRecordRead()) {
      throw new UsageLimitExceededError("read", {
        orgId: this.orgId,
        period: this.period,
      });
    }

    const reads = this.reads + 1;
    const reached = this.limits.reachedReads(reads) ? "read" : null;
    return new UsageMeter({ ...this.toJSON(), reads }, reached);
  }

  /**
   * Records one issued work-signal token (a "push session"). Symmetric with
   * {@link UsageMeter.recordRead}; the limit kind is "signal".
   */
  recordSignalToken(): UsageMeter {
    if (!this.canRecordSignalToken()) {
      throw new UsageLimitExceededError("signal", {
        orgId: this.orgId,
        period: this.period,
      });
    }

    const signalTokens = this.signalTokens + 1;
    const reached = this.limits.reachedSignalTokens(signalTokens)
      ? "signal"
      : null;
    return new UsageMeter({ ...this.toJSON(), signalTokens }, reached);
  }

  /**
   * Adjusts stored bytes. Positive `deltaBytes` is an archive add and IS guarded:
   * it throws {@link UsageLimitExceededError} (kind "storage") when it would
   * exceed the cap. Negative `deltaBytes` is lifecycle/expiry reconciliation and
   * is ALWAYS allowed, with the result floored at 0 (never throws). A zero delta
   * is a no-op returning a new instance with `limitReached` cleared.
   */
  recordBytes(deltaBytes: number): UsageMeter {
    if (!Number.isInteger(deltaBytes)) {
      throw new CoreValidationError(
        "Usage meter deltaBytes must be an integer",
        "INVALID_USAGE_BYTES_DELTA",
      );
    }

    if (deltaBytes > 0 && !this.canStore(deltaBytes)) {
      throw new UsageLimitExceededError("storage", {
        orgId: this.orgId,
        period: this.period,
      });
    }

    const storageBytes = Math.max(0, this.storageBytes + deltaBytes);
    const reached =
      deltaBytes > 0 && this.limits.reachedStorage(storageBytes)
        ? "storage"
        : null;
    return new UsageMeter({ ...this.toJSON(), storageBytes }, reached);
  }

  /**
   * Returns a new meter whose `storageBytes` is SET to an absolute value,
   * leaving `writes`/`reads`/`signalTokens` untouched. This is the reconciliation primitive
   * (Phase 6): retained storage is a point-in-time SNAPSHOT, not a monthly flow,
   * so reconciliation overwrites it with the recomputed source-of-truth total
   * rather than applying a delta via {@link UsageMeter.recordBytes}.
   *
   * Unlike `recordBytes(delta>0)`, this is NOT cap-guarded: reconciliation must
   * always be able to record the true retained quantity (the cap is enforced at
   * write time by the Phase 5 pre-flight guard, not by the meter snapshot). It
   * validates `bytes` is a non-negative integer and clears `limitReached`.
   */
  withStorageBytes(bytes: number): UsageMeter {
    const storageBytes = assertCount(bytes, "storageBytes");
    return new UsageMeter({ ...this.toJSON(), storageBytes }, null);
  }

  toJSON(): UsageMeterProps {
    return {
      orgId: this.orgId,
      period: this.period,
      planId: this.planId,
      writes: this.writes,
      reads: this.reads,
      storageBytes: this.storageBytes,
      signalTokens: this.signalTokens,
    };
  }
}
