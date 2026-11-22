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

export type ReconnectRequiredManagedConnectionEntityProps =
  ManagedConnectionEntityBaseProps & {
    /** The grant that stopped working; kept so disconnect can revoke it. */
    activeGrantId: UuidV7;
    candidateGrantId: UuidV7 | null;
    connectedByUserId: UuidV7;
    reasonCode: ManagedConnectionReasonCode;
  };

/**
 * The active grant can no longer be used (for example its refresh failed)
 * and someone has to reconnect. A reconnect's candidate waits here for
 * confirmation; confirming replaces the broken grant and bumps `generation`.
 */
export class ReconnectRequiredManagedConnectionEntity extends ManagedConnectionEntityBase {
  public readonly state = "reconnect_required" as const;
  public readonly activeGrantId: UuidV7;
  public readonly candidateGrantId: UuidV7 | null;
  public readonly connectedByUserId: UuidV7;
  public readonly reasonCode: ManagedConnectionReasonCode;

  private constructor(props: ReconnectRequiredManagedConnectionEntityProps) {
    const {
      activeGrantId,
      candidateGrantId,
      connectedByUserId,
      reasonCode,
      ...base
    } = props;
    super(base);
    this.activeGrantId = activeGrantId;
    this.candidateGrantId = candidateGrantId;
    this.connectedByUserId = connectedByUserId;
    this.reasonCode = reasonCode;
  }

  static rehydrate(
    props: ReconnectRequiredManagedConnectionEntityProps,
  ): ReconnectRequiredManagedConnectionEntity {
    return new ReconnectRequiredManagedConnectionEntity(props);
  }

  override startReconnect(now: Date): ManagedConnectionEntity {
    if (this.candidateGrantId !== null) {
      return super.startReconnect(now);
    }
    return this.withCandidate(null, now);
  }

  override attachCandidate(
    candidateGrantId: UuidV7,
    now: Date,
  ): ManagedConnectionEntity {
    if (this.candidateGrantId !== null) {
      return super.attachCandidate(candidateGrantId, now);
    }
    return this.withCandidate(candidateGrantId, now);
  }

  override confirmCandidate(
    candidateGrantId: UuidV7,
    fingerprint: string,
    input: ConfirmCandidateInput,
  ): ManagedConnectionEntity {
    if (this.candidateGrantId === null) {
      return super.confirmCandidate(candidateGrantId, fingerprint, input);
    }
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
    if (this.candidateGrantId === null) {
      return super.cancelCandidate(candidateGrantId, now);
    }
    this.assertCandidate(this.candidateGrantId, candidateGrantId);
    return this.withCandidate(null, now);
  }

  override expire(now: Date): ManagedConnectionEntity {
    if (this.candidateGrantId === null) {
      return super.expire(now);
    }
    return this.withCandidate(null, now);
  }

  override disconnect(now: Date): ManagedConnectionEntity {
    return DisconnectedManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: true }),
      reasonCode: null,
    });
  }

  get pendingCandidateGrantId(): UuidV7 | null {
    return this.candidateGrantId;
  }

  get servingGrantId(): null {
    return null;
  }

  toJSON(): ManagedConnectionRowProps {
    return {
      ...this.baseJSON(),
      state: this.state,
      reasonCode: this.reasonCode,
      activeGrantId: this.activeGrantId,
      candidateGrantId: this.candidateGrantId,
      connectedByUserId: this.connectedByUserId,
    };
  }

  private withCandidate(
    candidateGrantId: UuidV7 | null,
    now: Date,
  ): ManagedConnectionEntity {
    return ReconnectRequiredManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      activeGrantId: this.activeGrantId,
      candidateGrantId,
      connectedByUserId: this.connectedByUserId,
      reasonCode: this.reasonCode,
    });
  }
}
