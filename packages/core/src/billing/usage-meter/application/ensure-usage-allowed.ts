import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { UsageLimitExceededError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { currentBillingPeriod } from "../domain/billing-period";
import type { UsageMeterRepo } from "./usage-meter-repo";

/**
 * Which metered operation a pre-flight guard is checking. Storage headroom is
 * folded into the "write" check (an archive write also consumes storage), so the
 * guard surface stays "write" | "read"; the {@link UsageLimitExceededError} it
 * returns still distinguishes a "storage" overflow via its `kind`.
 */
export type UsageGuardKind = "write" | "read";

export type EnsureUsageAllowedDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Pre-flight quota guard for metered S3 operations (Phase 5). Loads the org's
 * meter for the current billing period and asks the entity whether there is
 * headroom for the requested operation, returning an `Err` carrying a
 * {@link UsageLimitExceededError} (HTTP 402) when the cap is reached.
 *
 * This use case is thin orchestration only: load -> ask the entity -> map to a
 * `Result`. ALL threshold math lives in {@link UsageMeter}; none is duplicated
 * here.
 *
 * Consistency: it loads via `loadOrStart`, which takes the row's `FOR UPDATE`
 * lock when a `dbExecutor` (transaction) is supplied. The caller threads the
 * SAME transaction into both this guard and the Phase-4 accounting handler that
 * runs immediately after, so the check-then-increment is serialized against
 * concurrent writers within one atomic unit. A brand-new org with no row yet
 * resolves to a zeroed meter (`loadOrStart` the deployment default plan), so it is
 * allowed.
 */
export const ensureUsageAllowed = async (
  orgId: UuidV7,
  kind: UsageGuardKind,
  opts: { addBytes?: number | undefined },
  deps: EnsureUsageAllowedDeps,
): Promise<Result<void, UsageLimitExceededError>> => {
  const period = currentBillingPeriod(deps.timeProvider.now());
  const meter = await deps.usageMeterRepo.loadOrStart(
    orgId,
    period,
    defaultPlanId(),
    deps.dbExecutor,
  );

  if (kind === "read") {
    if (!meter.canRecordRead()) {
      return Result.err(new UsageLimitExceededError("read", { orgId, period }));
    }
    return Result.ok(undefined);
  }

  if (!meter.canRecordWrite()) {
    return Result.err(new UsageLimitExceededError("write", { orgId, period }));
  }

  if (opts.addBytes != null && !meter.canStore(opts.addBytes)) {
    return Result.err(
      new UsageLimitExceededError("storage", { orgId, period }),
    );
  }

  return Result.ok(undefined);
};
