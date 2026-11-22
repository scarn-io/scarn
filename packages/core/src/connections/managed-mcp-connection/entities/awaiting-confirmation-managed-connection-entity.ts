import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import { DisconnectedManagedConnectionEntity } from "./disconnected-managed-connection-entity";
import {
  ManagedConnectionEntityBase,
  type ConfirmCandidateInput,
  type ManagedConnectionEntityBaseProps,
  type ManagedConnectionRowProps,
} from "./managed-connection-entity-base";
import { ReadyManagedConnectionEntity } from "./ready-managed-connection-entity";

export type AwaitingConfirmationManagedConnectionEntityProps =
  ManagedConnectionEntityBaseProps & {
    candidateGrantId: UuidV7;
  };

/**
 * A first connect came back from the provider with a candidate grant that
 * nobody has confirmed yet. The connection serves nothing until someone
 * confirms it.
 */
export class AwaitingConfirmationManagedConnectionEntity extends ManagedConnectionEntityBase {
  public readonly state = "awaiting_confirmation" as const;
  public readonly candidateGrantId: UuidV7;

  private constructor(props: AwaitingConfirmationManagedConnectionEntityProps) {
    const { candidateGrantId, ...base } = props;
    super(base);
    this.candidateGrantId = candidateGrantId;
  }

  static rehydrate(
    props: AwaitingConfirmationManagedConnectionEntityProps,
  ): AwaitingConfirmationManagedConnectionEntity {
    return new AwaitingConfirmationManagedConnectionEntity(props);
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
      ...this.nextProps(input.now, { bumpGeneration: false }),
      activeGrantId: this.candidateGrantId,
      connectedByUserId: input.confirmedByUserId,
    });
  }

  override cancelCandidate(
    candidateGrantId: UuidV7,
    now: Date,
  ): ManagedConnectionEntity {
    this.assertCandidate(this.candidateGrantId, candidateGrantId);
    return DisconnectedManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      reasonCode: "candidate_cancelled",
    });
  }

  override expire(now: Date): ManagedConnectionEntity {
    return DisconnectedManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      reasonCode: "candidate_expired",
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

  get servingGrantId(): null {
    return null;
  }

  toJSON(): ManagedConnectionRowProps {
    return {
      ...this.baseJSON(),
      state: this.state,
      reasonCode: null,
      activeGrantId: null,
      candidateGrantId: this.candidateGrantId,
      connectedByUserId: null,
    };
  }
}
