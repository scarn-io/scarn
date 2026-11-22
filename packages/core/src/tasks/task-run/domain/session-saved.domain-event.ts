import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const SESSION_SAVED_DOMAIN_EVENT_TYPE = "task-run.session-saved";

export type SessionSavedDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  /** The size the worker reported for the uploaded export; 0 when it sent none. */
  sizeBytes: number;
};

/** A run's yield recorded the agent session the worker exported and uploaded. */
export class SessionSavedDomainEvent implements DomainEvent<
  typeof SESSION_SAVED_DOMAIN_EVENT_TYPE,
  SessionSavedDomainEventPayload
> {
  readonly type = SESSION_SAVED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: SessionSavedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}
