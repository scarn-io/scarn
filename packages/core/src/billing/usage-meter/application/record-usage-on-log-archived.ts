import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type {
  DomainEventHandler,
  DomainEventHandlerContext,
} from "@scarn/core/lib/domain-events/domain-event";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { UsageLimitExceededError } from "@scarn/core/lib/errors";
import type { LogArchivedDomainEvent } from "@scarn/core/tasks/task-log/domain/log-archived.domain-event";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { currentBillingPeriod } from "../domain/billing-period";
import { UsageLimitReachedDomainEvent } from "../domain/usage-limit-reached.domain-event";
import type { UsageMeter } from "../domain/usage-meter-entity";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type RecordUsageOnLogArchivedDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
};

/**
 * Accounting handler for the WRITE + STORAGE side of usage metering. Reacts to
 * {@link LogArchivedDomainEvent} (emitted AFTER a successful S3 archive write)
 * and increments the org's monthly {@link UsageMeter}.
 *
 * ACCOUNTING ONLY (Phase 4): we record usage that ALREADY happened, so we must
 * never throw back into the publishing transaction (which is the step-completion
 * tx) and we must never lose the write increment.
 *
 * Bytes-accounting-doesn't-throw decision: `UsageMeter.recordBytes(delta>0)` is
 * GUARDED — it throws `UsageLimitExceededError` (kind "storage") when the add
 * would exceed the storage cap. In Phase 5 a pre-flight guard prevents over-cap
 * writes from happening, so in the normal path the add is within cap. For safety
 * here, if the storage add WOULD overflow we catch it, log, and persist the
 * write increment WITHOUT the bytes (the write count must reflect reality; the
 * already-written bytes are reconciled by Phase 5 enforcement / lifecycle). The
 * write increment is recorded unconditionally.
 */
export class RecordUsageOnLogArchived implements DomainEventHandler<LogArchivedDomainEvent> {
  constructor(private readonly deps: RecordUsageOnLogArchivedDeps) {}

  async handle(
    event: LogArchivedDomainEvent,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    const period = currentBillingPeriod(this.deps.timeProvider.now());

    const meter = await this.loadOrStart(event.payload.orgId, period, context);

    const afterWrite = meter.recordWrite();
    const nextMeter = this.applyBytes(afterWrite, event.payload.sizeBytes);

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

  private applyBytes(meter: UsageMeter, sizeBytes: number): UsageMeter {
    try {
      return meter.recordBytes(sizeBytes);
    } catch (error) {
      if (
        error instanceof UsageLimitExceededError &&
        error.kind === "storage"
      ) {
        this.deps.logger?.warn(
          {
            orgId: meter.orgId,
            period: meter.period,
            sizeBytes,
          },
          "Storage cap exceeded while accounting an already-written log archive; recording write without bytes",
        );
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
