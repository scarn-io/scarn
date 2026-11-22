import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import { DisconnectedManagedConnectionEntity } from "./disconnected-managed-connection-entity";
import {
  ManagedConnectionEntityBase,
  type ManagedConnectionEntityBaseProps,
  type ManagedConnectionReasonCode,
  type ManagedConnectionRowProps,
} from "./managed-connection-entity-base";
import { ReadyWithPendingReconnectManagedConnectionEntity } from "./ready-with-pending-reconnect-managed-connection-entity";
import { ReconnectRequiredManagedConnectionEntity } from "./reconnect-required-managed-connection-entity";

export type ReadyManagedConnectionEntityProps =
  ManagedConnectionEntityBaseProps & {
    activeGrantId: UuidV7;
    /** Who confirmed the active grant. */
    connectedByUserId: UuidV7;
  };

/**
 * A connection serving a confirmed grant. A reconnect attempt can be under
 * way without changing the state: only a candidate coming back moves it to
 * `ready_with_pending_reconnect`.
 */
export class ReadyManagedConnectionEntity extends ManagedConnectionEntityBase {
  public readonly state = "ready" as const;
  public readonly activeGrantId: UuidV7;
  public readonly connectedByUserId: UuidV7;

  private constructor(props: ReadyManagedConnectionEntityProps) {
    const { activeGrantId, connectedByUserId, ...base } = props;
    super(base);
    this.activeGrantId = activeGrantId;
    this.connectedByUserId = connectedByUserId;
  }

  static rehydrate(
    props: ReadyManagedConnectionEntityProps,
  ): ReadyManagedConnectionEntity {
    return new ReadyManagedConnectionEntity(props);
  }

  override startReconnect(now: Date): ManagedConnectionEntity {
    return ReadyManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      activeGrantId: this.activeGrantId,
      connectedByUserId: this.connectedByUserId,
    });
  }

  override attachCandidate(
    candidateGrantId: UuidV7,
    now: Date,
  ): ManagedConnectionEntity {
    return ReadyWithPendingReconnectManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      activeGrantId: this.activeGrantId,
      candidateGrantId,
      connectedByUserId: this.connectedByUserId,
    });
  }

  override requireReconnect(
    reasonCode: ManagedConnectionReasonCode,
    now: Date,
  ): ManagedConnectionEntity {
    return ReconnectRequiredManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      activeGrantId: this.activeGrantId,
      candidateGrantId: null,
      connectedByUserId: this.connectedByUserId,
      reasonCode,
    });
  }

  override disconnect(now: Date): ManagedConnectionEntity {
    return DisconnectedManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: true }),
      reasonCode: null,
    });
  }

  get pendingCandidateGrantId(): null {
    return null;
  }

  get servingGrantId(): UuidV7 {
    return this.activeGrantId;
  }

  toJSON(): ManagedConnectionRowProps {
    return {
      ...this.baseJSON(),
      state: this.state,
      reasonCode: null,
      activeGrantId: this.activeGrantId,
      candidateGrantId: null,
      connectedByUserId: this.connectedByUserId,
    };
  }
}
