import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const USAGE_LIMIT_REACHED_DOMAIN_EVENT_TYPE = "usage.limit-reached";

export type UsageLimitKind = "write" | "read" | "storage" | "signal";

export type UsageLimitReachedDomainEventPayload = {
  orgId: UuidV7;
  period: string;
  kind: UsageLimitKind;
};

export class UsageLimitReachedDomainEvent implements DomainEvent<
  typeof USAGE_LIMIT_REACHED_DOMAIN_EVENT_TYPE,
  UsageLimitReachedDomainEventPayload
> {
  readonly type = USAGE_LIMIT_REACHED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: UsageLimitReachedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}
