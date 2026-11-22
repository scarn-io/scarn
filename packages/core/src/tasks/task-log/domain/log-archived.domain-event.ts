import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const LOG_ARCHIVED_DOMAIN_EVENT_TYPE = "task-log.archived";

export type LogArchivedDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  sizeBytes: number;
};

export class LogArchivedDomainEvent implements DomainEvent<
  typeof LOG_ARCHIVED_DOMAIN_EVENT_TYPE,
  LogArchivedDomainEventPayload
> {
  readonly type = LOG_ARCHIVED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: LogArchivedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}
