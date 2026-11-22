import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE =
  "task-log.archive-retrieved";

export type LogArchiveRetrievedDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
};

export class LogArchiveRetrievedDomainEvent implements DomainEvent<
  typeof LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE,
  LogArchiveRetrievedDomainEventPayload
> {
  readonly type = LOG_ARCHIVE_RETRIEVED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: LogArchiveRetrievedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}
