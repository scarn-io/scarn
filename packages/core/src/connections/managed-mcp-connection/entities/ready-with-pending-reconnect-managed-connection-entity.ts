import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import { DisconnectedManagedConnectionEntity } from "./disconnected-managed-connection-entity";
import {
  ManagedConnectionEntityBase,
  type ConfirmCandidateInput,
  type ManagedConnectionEntityBaseProps,
  type ManagedConnectionReasonCode,
  type ManagedConnectionRowProps,
} from "./managed-connection-entity-base";
import { ReadyManagedConnectionEntity } from "./ready-managed-connection-entity";
import { ReconnectRequiredManagedConnectionEntity } from "./reconnect-required-managed-connection-entity";

export type ReadyWithPendingReconnectManagedConnectionEntityProps =
  ManagedConnectionEntityBaseProps & {
    activeGrantId: UuidV7;
    candidateGrantId: UuidV7;
    connectedByUserId: UuidV7;
  };

/**
 * A reconnect came back with a candidate grant while the active grant keeps
 * serving. Confirming swaps them and bumps `generation`; cancelling or
 * letting the candidate expire leaves the active grant untouched.
 */
export class ReadyWithPendingReconnectManagedConnectionEntity extends ManagedConnectionEntityBase {
  public readonly state = "ready_with_pending_reconnect" as const;
  public readonly activeGrantId: UuidV7;
  public readonly candidateGrantId: UuidV7;
  public readonly connectedByUserId: UuidV7;

  private constructor(
    props: ReadyWithPendingReconnectManagedConnectionEntityProps,
  ) {
    const { activeGrantId, candidateGrantId, connectedByUserId, ...base } =
      props;
    super(base);
    this.activeGrantId = activeGrantId;
    this.candidateGrantId = candidateGrantId;
    this.connectedByUserId = connectedByUserId;
  }

  static rehydrate(
    props: ReadyWithPendingReconnectManagedConnectionEntityProps,
  ): ReadyWithPendingReconnectManagedConnectionEntity {
    return new ReadyWithPendingReconnectManagedConnectionEntity(props);
  }

  override confirmCandidate(
    candidateGrantId: UuidV7,
    fingerprint: string,
    input: ConfirmCandidateInput,
  ): ManagedConnectionEntity {
    this.assertConfirmable(
      this.candidateGrantId,
      candidateGrantId,
      fingerprint,
      input,
    );
    return ReadyManagedConnectionEntity.rehydrate({
      ...this.nextProps(input.now, { bumpGeneration: true }),
      activeGrantId: this.candidateGrantId,
      connectedByUserId: input.confirmedByUserId,
    });
  }

  override cancelCandidate(
    candidateGrantId: UuidV7,
    now: Date,
  ): ManagedConnectionEntity {
    this.assertCandidate(this.candidateGrantId, candidateGrantId);
    return this.dropCandidate(now);
  }

  override expire(now: Date): ManagedConnectionEntity {
    return this.dropCandidate(now);
  }

  override requireReconnect(
    reasonCode: ManagedConnectionReasonCode,
    now: Date,
  ): ManagedConnectionEntity {
    return ReconnectRequiredManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      activeGrantId: this.activeGrantId,
      candidateGrantId: this.candidateGrantId,
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

  get pendingCandidateGrantId(): UuidV7 {
    return this.candidateGrantId;
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
      candidateGrantId: this.candidateGrantId,
      connectedByUserId: this.connectedByUserId,
    };
  }

  private dropCandidate(now: Date): ManagedConnectionEntity {
    return ReadyManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      activeGrantId: this.activeGrantId,
      connectedByUserId: this.connectedByUserId,
    });
  }
}
