import { defaultPlanId } from "@scarn/core/billing/plan/application/default-plan-id";
import type {
  DomainEventHandler,
  DomainEventHandlerContext,
} from "@scarn/core/lib/domain-events/domain-event";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { UsageLimitExceededError } from "@scarn/core/lib/errors";
import type { SessionSavedDomainEvent } from "@scarn/core/tasks/task-run/domain/session-saved.domain-event";
import { currentBillingPeriod } from "../domain/billing-period";
import { UsageLimitReachedDomainEvent } from "../domain/usage-limit-reached.domain-event";
import type { UsageMeter } from "../domain/usage-meter-entity";
import type { UsageMeterRepo } from "./usage-meter-repo";

export type RecordUsageOnSessionSavedDeps = {
  usageMeterRepo: UsageMeterRepo;
  timeProvider: TimeProvider;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
};

/**
 * Accounting handler for a saved agent session ({@link SessionSavedDomainEvent},
 * published by a yield that attached one). Mirrors
 * {@link RecordUsageOnLogArchived}: the upload already happened (the upload-URL
 * pre-flight was the guard), so this records one write plus the session's
 * bytes and never throws a usage limit back into the yield. When the bytes
 * would go over the storage cap it records the write without them and logs;
 * the next reconciliation counts them from `session_size_bytes`.
 */
export class RecordUsageOnSessionSaved implements DomainEventHandler<SessionSavedDomainEvent> {
  constructor(private readonly deps: RecordUsageOnSessionSavedDeps) {}

  async handle(
    event: SessionSavedDomainEvent,
    context: DomainEventHandlerContext,
  ): Promise<void> {
    const period = currentBillingPeriod(this.deps.timeProvider.now());
    const meter = await this.deps.usageMeterRepo.loadOrStart(
      event.payload.orgId,
      period,
      defaultPlanId(),
      context.tx,
    );

    const nextMeter = this.applyBytes(
      this.applyWrite(meter),
      event.payload.sizeBytes,
    );
    await this.deps.usageMeterRepo.save(nextMeter, context.tx);

    if (nextMeter.limitReached && this.deps.domainEventDispatcher) {
      await this.deps.domainEventDispatcher.publish(
        [
          new UsageLimitReachedDomainEvent({
            orgId: nextMeter.orgId,
            period: nextMeter.period,
            kind: nextMeter.limitReached,
          }),
        ],
        context.tx,
      );
    }
  }

  private applyWrite(meter: UsageMeter): UsageMeter {
    try {
      return meter.recordWrite();
    } catch (error) {
      if (error instanceof UsageLimitExceededError && error.kind === "write") {
        this.deps.logger?.warn(
          { orgId: meter.orgId, period: meter.period },
          "Write cap exceeded while accounting an already-saved agent session; skipping the write",
        );
        return meter;
      }
      throw error;
    }
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
          { orgId: meter.orgId, period: meter.period, sizeBytes },
          "Storage cap exceeded while accounting an already-saved agent session; recording write without bytes",
        );
        return meter;
      }
      throw error;
    }
  }
}
