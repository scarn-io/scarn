import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  DomainEventHandler,
  DomainEventHandlerContext,
} from "@scarn/core/lib/domain-events/domain-event";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { LogArchiveRetrievedDomainEvent } from "@scarn/core/tasks/task-log/domain/log-archive-retrieved.domain-event";
import { currentBillingPeriod } from "../domain/billing-period";
import { UsageLimitReachedDomainEvent } from "../domain/usage-limit-reached.domain-event";
import type { UsageMeter } from "../domain/usage-meter-entity";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type RecordUsageOnLogArchiveRetrievedDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
};

/**
 * Accounting handler for the READ side of usage metering. Reacts to
 * {@link LogArchiveRetrievedDomainEvent} (emitted AFTER a presigned URL is
 * minted or an archive is proxied) and increments the org's monthly read count.
 *
 * ACCOUNTING ONLY (Phase 4): records usage that already happened; reads are
 * recorded unconditionally and this handler does not block. `recordRead()` only
 * throws when there is no headroom — Phase 5 pre-flight enforcement guarantees
 * we never reach this handler over-cap in the normal path.
 */
export class RecordUsageOnLogArchiveRetrieved implements DomainEventHandler<LogArchiveRetrievedDomainEvent> {
  constructor(private readonly deps: RecordUsageOnLogArchiveRetrievedDeps) {}

  async handle(
    event: LogArchiveRetrievedDomainEvent,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    const period = currentBillingPeriod(this.deps.timeProvider.now());

    const meter = await this.loadOrStart(event.payload.orgId, period, context);

    const nextMeter = meter.recordRead();

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
