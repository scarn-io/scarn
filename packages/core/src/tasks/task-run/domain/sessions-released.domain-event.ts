import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const SESSIONS_RELEASED_DOMAIN_EVENT_TYPE = "task-run.sessions-released";

export type SessionsReleasedDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunIds: UuidV7[];
  /** The recorded sizes of the released sessions, summed. */
  sizeBytes: number;
};

/**
 * Saved agent sessions stopped being kept: a newer run of their Task saved
 * one, or their Task ended. Their columns are cleared and their objects are
 * deleted after commit.
 */
export class SessionsReleasedDomainEvent implements DomainEvent<
  typeof SESSIONS_RELEASED_DOMAIN_EVENT_TYPE,
  SessionsReleasedDomainEventPayload
> {
  readonly type = SESSIONS_RELEASED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: SessionsReleasedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}
