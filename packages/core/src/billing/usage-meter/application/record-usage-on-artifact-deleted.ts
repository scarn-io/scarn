import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type {
  DomainEventHandler,
  DomainEventHandlerContext,
} from "@scarn/core/lib/domain-events/domain-event";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ArtifactDeletedDomainEvent } from "@scarn/core/tasks/task-artifact/domain/artifact-deleted.domain-event";
import { currentBillingPeriod } from "../domain/billing-period";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type RecordUsageOnArtifactDeletedDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
};

/**
 * Billing-reversal counterpart to {@link RecordUsageOnArtifactStored}. Reacts
 * to {@link ArtifactDeletedDomainEvent} and decrements the org's monthly
 * {@link UsageMeter} storage total by the deleted artifact's size.
 *
 * Unlike the stored-side handler, there is no cap-guard/catch branch here:
 * per {@link UsageMeter.recordBytes}'s documented negative-delta behavior
 * (floors at 0, never throws — see `usage-meter-entity.ts:161-189`), a
 * negative delta can never exceed a cap or throw, so there is nothing to
 * catch.
 */
export class RecordUsageOnArtifactDeleted implements DomainEventHandler<ArtifactDeletedDomainEvent> {
  constructor(private readonly deps: RecordUsageOnArtifactDeletedDeps) {}

  async handle(
    event: ArtifactDeletedDomainEvent,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    const period = currentBillingPeriod(this.deps.timeProvider.now());

    const meter = await this.deps.usageMeterRepo.loadOrStart(
      event.payload.orgId,
      period,
      defaultPlanId(),
      context.tx,
    );

    const next = meter.recordBytes(-event.payload.sizeBytes);

    await this.deps.usageMeterRepo.save(next, context.tx);
  }
}
