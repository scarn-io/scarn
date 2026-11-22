import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import { AwaitingConfirmationManagedConnectionEntity } from "./awaiting-confirmation-managed-connection-entity";
import { DisconnectedManagedConnectionEntity } from "./disconnected-managed-connection-entity";
import {
  ManagedConnectionEntityBase,
  type ManagedConnectionEntityBaseProps,
  type ManagedConnectionRowProps,
} from "./managed-connection-entity-base";

/**
 * A first connect is under way: an authorization attempt is out at the
 * provider and no grant exists yet. Starting again replaces the attempt.
 */
export class ConnectingManagedConnectionEntity extends ManagedConnectionEntityBase {
  public readonly state = "connecting" as const;

  private constructor(props: ManagedConnectionEntityBaseProps) {
    super(props);
  }

  static rehydrate(
    props: ManagedConnectionEntityBaseProps,
  ): ConnectingManagedConnectionEntity {
    return new ConnectingManagedConnectionEntity(props);
  }

  override startConnect(now: Date): ManagedConnectionEntity {
    return ConnectingManagedConnectionEntity.rehydrate(
      this.nextProps(now, { bumpGeneration: false }),
    );
  }

  override attachCandidate(
    candidateGrantId: UuidV7,
    now: Date,
  ): ManagedConnectionEntity {
    return AwaitingConfirmationManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      candidateGrantId,
    });
  }

  override expire(now: Date): ManagedConnectionEntity {
    return DisconnectedManagedConnectionEntity.rehydrate({
      ...this.nextProps(now, { bumpGeneration: false }),
      reasonCode: "attempt_expired",
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

  get servingGrantId(): null {
    return null;
  }

  toJSON(): ManagedConnectionRowProps {
    return {
      ...this.baseJSON(),
      state: this.state,
      reasonCode: null,
      activeGrantId: null,
      candidateGrantId: null,
      connectedByUserId: null,
    };
  }
}
