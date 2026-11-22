import type { DbTransaction } from "@scarn/core/lib/db/db-executor";

export type DomainEvent<
  TType extends string = string,
  TPayload = unknown,
> = {
  type: TType;
  payload: TPayload;
  occurredAt: Date;
};

export type DomainEventHandlerContext = {
  tx: DbTransaction;
};

export type DomainEventHandler<
  TEvent extends DomainEvent = DomainEvent,
> = {
  handle(event: TEvent, context: DomainEventHandlerContext): Promise<void>;
};
