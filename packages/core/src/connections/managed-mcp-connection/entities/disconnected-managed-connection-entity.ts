import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import type { ManagedConnectionDefinition } from "../domain/managed-connection-server";
import { ConnectingManagedConnectionEntity } from "./connecting-managed-connection-entity";
import {
  ManagedConnectionEntityBase,
  type ManagedConnectionEntityBaseProps,
  type ManagedConnectionReasonCode,
  type ManagedConnectionRowProps,
} from "./managed-connection-entity-base";

export type DisconnectedManagedConnectionEntityProps =
  ManagedConnectionEntityBaseProps & {
    /** Why the last connect ended without a grant, if it did. */
    reasonCode: ManagedConnectionReasonCode | null;
  };

export type CreateManagedConnectionEntityProps = ManagedConnectionDefinition & {
  id?: UuidV7 | undefined;
  projectId: UuidV7;
  now: Date;
};

/**
 * A connection with no grant: newly created, never confirmed, or a
 * disconnected tombstone. The row is kept so its ID never rebinds to another
 * account; connecting again starts from here.
 */
export class DisconnectedManagedConnectionEntity extends ManagedConnectionEntityBase {
  public readonly state = "disconnected" as const;
  public readonly reasonCode: ManagedConnectionReasonCode | null;

  private constructor(props: DisconnectedManagedConnectionEntityProps) {
    const { reasonCode, ...base } = props;
    super(base);
    this.reasonCode = reasonCode;
  }

  static create(
    props: CreateManagedConnectionEntityProps,
  ): DisconnectedManagedConnectionEntity {
    return new DisconnectedManagedConnectionEntity({
      id: props.id ?? createUuidV7(),
      projectId: props.projectId,
      name: props.name,
      label: props.label,
      preset: props.preset,
      server: props.server,
      generation: 0,
      version: 0,
      reasonCode: null,
      createdAt: props.now,
      updatedAt: props.now,
    });
  }

  static rehydrate(
    props: DisconnectedManagedConnectionEntityProps,
  ): DisconnectedManagedConnectionEntity {
    return new DisconnectedManagedConnectionEntity(props);
  }

  override startConnect(now: Date): ManagedConnectionEntity {
    return ConnectingManagedConnectionEntity.rehydrate(
      this.nextProps(now, { bumpGeneration: false }),
    );
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
      reasonCode: this.reasonCode,
      activeGrantId: null,
      candidateGrantId: null,
      connectedByUserId: null,
    };
  }
}
