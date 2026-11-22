import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  parseUuidV7,
  uuidV7Schema,
} from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import { assertOrganizationMember } from "@scarn/core/organizations/organization/application/organization-authorization";
import { currentBillingPeriod } from "../domain/billing-period";
import { STORAGE_RETENTION_DAYS } from "../domain/storage-retention";
import { UsageMeter } from "../domain/usage-meter-entity";
import { usageMeterEntityToContract } from "./usage-meter-contract-mapper";
import type { StorageUsageReader } from "./storage-usage-reader";
import type { UsageMeterRepo } from "./usage-meter-repo";
import type { UsageMeterContract } from "../contracts/usage-meter-contracts";

export type GetOrgUsageDeps = {
  userAuthz: UserAuthorizationService;
  orgRepo: OrgRepo;
  usageMeterRepo: UsageMeterRepo;
  storageUsageReader: StorageUsageReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Read-only use case (Phase 7) exposing an org's CURRENT-period usage meter.
 * Thin orchestration: parse -> load org -> authorize -> load (or synthesize) the
 * meter -> map to contract.
 *
 * Read-only on a missing row: when no meter exists for the current period yet,
 * a zeroed `UsageMeter.startPeriod(...)` is returned but NOT persisted (matching
 * `loadOrStart`'s contract — persistence happens on the next `record*` save).
 *
 * Timestamps: `UsageMeter` is timestamp-free by design; the row's
 * `createdAt`/`updatedAt` are not surfaced by the repo's read methods, so the
 * mapper is fed the current time, which is the mapper's documented fallback for
 * a not-yet-persisted meter. This endpoint is a point-in-time usage snapshot,
 * not an audit-trail surface, so synthesized timestamps are acceptable.
 */
export const getOrgUsage = async (
  orgIdInput: string,
  {
    userAuthz,
    orgRepo,
    usageMeterRepo,
    storageUsageReader,
    timeProvider,
    dbExecutor,
  }: GetOrgUsageDeps,
): Promise<Result<UsageMeterContract, ResourceNotFoundError>> => {
  const orgId = parseUuidV7(uuidV7Schema.parse(orgIdInput));
  const organization = await orgRepo.load(orgId, dbExecutor);

  if (!organization) {
    return Result.err(new ResourceNotFoundError("Organization", orgId));
  }

  assertOrganizationMember(organization, userAuthz.actorId);

  const now = timeProvider.now();
  const period = currentBillingPeriod(now);
  const meter =
    (await usageMeterRepo.loadForPeriod(orgId, period, dbExecutor)) ??
    UsageMeter.startPeriod(orgId, period, defaultPlanId());

  // Live breakdown (artifacts vs. log archives), computed from the same
  // source-of-truth tables the reconciliation sweep sums, rather than
  // persisted on the meter — see `usageStorageBreakdownSchema` for why this
  // can drift briefly from `storageBytes`.
  const storageBreakdown =
    await storageUsageReader.getRetainedBytesBreakdownForOrg(
      orgId,
      now,
      STORAGE_RETENTION_DAYS,
      dbExecutor,
    );

  return Result.ok(
    usageMeterEntityToContract(
      meter,
      { createdAt: now, updatedAt: now },
      storageBreakdown,
    ),
  );
};
