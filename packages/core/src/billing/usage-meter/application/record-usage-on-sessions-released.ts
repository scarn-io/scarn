import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type {
  DomainEventHandler,
  DomainEventHandlerContext,
} from "@scarn/core/lib/domain-events/domain-event";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { SessionsReleasedDomainEvent } from "@scarn/core/tasks/task-run/domain/sessions-released.domain-event";
import { currentBillingPeriod } from "../domain/billing-period";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type RecordUsageOnSessionsReleasedDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
};

/**
 * Reversal counterpart to {@link RecordUsageOnSessionSaved}, modeled on
 * {@link RecordUsageOnArtifactDeleted}: subtracts the released sessions'
 * recorded bytes from the org's meter. A negative delta floors at 0 and never
 * throws. Like every yield-time update this is an estimate; reconciliation
 * overwrites it from the stored sizes.
 */
export class RecordUsageOnSessionsReleased implements DomainEventHandler<SessionsReleasedDomainEvent> {
  constructor(private readonly deps: RecordUsageOnSessionsReleasedDeps) {}

  async handle(
    event: SessionsReleasedDomainEvent,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    if (event.payload.sizeBytes <= 0) {
      return;
    }
    const period = currentBillingPeriod(this.deps.timeProvider.now());
    const meter = await this.deps.usageMeterRepo.loadOrStart(
      event.payload.orgId,
      period,
      defaultPlanId(),
      context.tx,
    );
    await this.deps.usageMeterRepo.save(
      meter.recordBytes(-event.payload.sizeBytes),
      context.tx,
    );
  }
}
