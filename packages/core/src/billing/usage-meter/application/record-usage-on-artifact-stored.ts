import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type {
  DomainEventHandler,
  DomainEventHandlerContext,
} from "@scarn/core/lib/domain-events/domain-event";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { UsageLimitExceededError } from "@scarn/core/lib/errors";
import type { ArtifactStoredDomainEvent } from "@scarn/core/tasks/task-artifact/domain/artifact-stored.domain-event";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { currentBillingPeriod } from "../domain/billing-period";
import { UsageLimitReachedDomainEvent } from "../domain/usage-limit-reached.domain-event";
import type { UsageMeter } from "../domain/usage-meter-entity";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type RecordUsageOnArtifactStoredDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
};

/**
 * Accounting handler for the WRITE + STORAGE side of usage metering for
 * uploaded task artifacts. Reacts to {@link ArtifactStoredDomainEvent}
 * (emitted AFTER an artifact's metadata is persisted) and increments the org's
 * monthly {@link UsageMeter}.
 *
 * Mirrors {@link RecordUsageOnLogArchived}: ACCOUNTING ONLY — usage that already
 * happened, so it must never throw back into the publishing transaction and must
 * never lose the write increment. If the storage add would overflow the cap we
 * catch, log, and persist the write increment WITHOUT the bytes (reconciled by
 * enforcement / lifecycle). The write increment is recorded unconditionally.
 *
 * As of Phase 1 (`create-artifact-upload-url.ts` pre-flights `ensureUsageAllowed`
 * before minting an upload URL), this catch branch is no longer an expected,
 * benign path — a legitimately-gated org should never reach an upload that
 * lands here over cap. Hitting it now indicates the pre-flight was bypassed or
 * raced: e.g. the worker didn't supply `sizeBytes` at mint time (so only the
 * write-count cap was checked, not storage), the mint-time estimate and the
 * `recordArtifact` size disagree, or a concurrent upload landed between the
 * mint-time check and this accounting event. It is logged at `error` (not
 * `warn`) to surface that as an anomaly worth investigating, while still never
 * throwing back into the publishing transaction — the artifact's S3 upload and
 * DB row are already durable, so rolling back here would discard a real,
 * already-stored artifact purely over an accounting mismatch, which is worse
 * than the mismatch itself.
 */
export class RecordUsageOnArtifactStored implements DomainEventHandler<ArtifactStoredDomainEvent> {
  constructor(private readonly deps: RecordUsageOnArtifactStoredDeps) {}

  async handle(
    event: ArtifactStoredDomainEvent,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    const period = currentBillingPeriod(this.deps.timeProvider.now());

    const meter = await this.loadOrStart(event.payload.orgId, period, context);

    const afterWrite = meter.recordWrite();
    const nextMeter = await this.applyBytes(
      afterWrite,
      event.payload.sizeBytes,
      context,
    );

    await this.deps.usageMeterRepo.save(nextMeter, context.tx);

    await this.publishLimitReached(nextMeter, context);
  }

  private async loadOrStart(
    orgId: UuidV7,
    period: string,
    context: DomainEventHandlerContext,
  ): Promise<UsageMeter> {
    const existing = await this.deps.usageMeterRepo.loadForPeriod(
      orgId,
      period,
      context.tx,
    );
    if (existing) {
      return existing;
    }

    return await this.deps.usageMeterRepo.loadOrStart(
      orgId,
      period,
      defaultPlanId(),
      context.tx,
    );
  }

  private async applyBytes(
    meter: UsageMeter,
    sizeBytes: number,
    context: DomainEventHandlerContext,
  ): Promise<UsageMeter> {
    try {
      return meter.recordBytes(sizeBytes);
    } catch (error) {
      if (
        error instanceof UsageLimitExceededError &&
        error.kind === "storage"
      ) {
        // Now an anomaly, not an expected path — see the class docstring.
        // `meter` here is the post-write, PRE-bytes instance (recordBytes threw
        // before producing a new one), so its `limitReached` does not reflect
        // this storage overflow. Publish the "storage" limit-reached event
        // explicitly rather than relying on `meter.limitReached`, so downstream
        // consumers still learn the cap was hit even though we didn't apply the
        // bytes.
        this.deps.logger?.error(
          {
            orgId: meter.orgId,
            period: meter.period,
            sizeBytes,
          },
          "Storage cap exceeded while accounting an already-stored artifact " +
            "(post-Phase-1 upload gating should have prevented this); " +
            "recording write without bytes",
        );
        if (this.deps.domainEventDispatcher) {
          await this.deps.domainEventDispatcher.publish(
            [
              new UsageLimitReachedDomainEvent({
                orgId: meter.orgId,
                period: meter.period,
                kind: "storage",
              }),
            ],
            context.tx,
          );
        }
        return meter;
      }

      throw error;
    }
  }

  private async publishLimitReached(
    meter: UsageMeter,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    if (!meter.limitReached || !this.deps.domainEventDispatcher) {
      return;
    }

    await this.deps.domainEventDispatcher.publish(
      [
        new UsageLimitReachedDomainEvent({
          orgId: meter.orgId,
          period: meter.period,
          kind: meter.limitReached,
        }),
      ],
      context.tx,
    );
  }
}
