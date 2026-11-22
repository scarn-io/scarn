/**
 * `ManagedConnectionEntity` is a discriminated union of one class per state,
 * so each state carries exactly the grant IDs it is guaranteed to have.
 * Callers narrow on `.state`. Transitions return the class of the state they
 * move to; an illegal transition throws `MANAGED_CONNECTION_STATE_CONFLICT`.
 *
 * `ManagedConnectionEntity` is also a companion value whose `rehydrate`
 * dispatches on `state` from the flat `managed_mcp_connections` row.
 */
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { AwaitingConfirmationManagedConnectionEntity } from "../entities/awaiting-confirmation-managed-connection-entity";
import { ConnectingManagedConnectionEntity } from "../entities/connecting-managed-connection-entity";
import {
  DisconnectedManagedConnectionEntity,
  type CreateManagedConnectionEntityProps,
} from "../entities/disconnected-managed-connection-entity";
import type { ManagedConnectionRowProps } from "../entities/managed-connection-entity-base";
import { ReadyManagedConnectionEntity } from "../entities/ready-managed-connection-entity";
import { ReadyWithPendingReconnectManagedConnectionEntity } from "../entities/ready-with-pending-reconnect-managed-connection-entity";
import { ReconnectRequiredManagedConnectionEntity } from "../entities/reconnect-required-managed-connection-entity";

export {
  ManagedConnectionEntityBase,
  isManagedConnectionReasonCode,
  managedConnectionCandidateMismatch,
  managedConnectionReasonCodeValues,
  managedConnectionStateValues,
  type ConfirmCandidateInput,
  type ManagedConnectionEntityBaseProps,
  type ManagedConnectionReasonCode,
  type ManagedConnectionRowProps,
  type ManagedConnectionState,
  type ManagedConnectionTransition,
} from "../entities/managed-connection-entity-base";
export {
  DisconnectedManagedConnectionEntity,
  type CreateManagedConnectionEntityProps,
  type DisconnectedManagedConnectionEntityProps,
} from "../entities/disconnected-managed-connection-entity";
export { ConnectingManagedConnectionEntity } from "../entities/connecting-managed-connection-entity";
export {
  AwaitingConfirmationManagedConnectionEntity,
  type AwaitingConfirmationManagedConnectionEntityProps,
} from "../entities/awaiting-confirmation-managed-connection-entity";
export {
  ReadyManagedConnectionEntity,
  type ReadyManagedConnectionEntityProps,
} from "../entities/ready-managed-connection-entity";
export {
  ReadyWithPendingReconnectManagedConnectionEntity,
  type ReadyWithPendingReconnectManagedConnectionEntityProps,
} from "../entities/ready-with-pending-reconnect-managed-connection-entity";
export {
  ReconnectRequiredManagedConnectionEntity,
  type ReconnectRequiredManagedConnectionEntityProps,
} from "../entities/reconnect-required-managed-connection-entity";

export type ManagedConnectionEntity =
  | DisconnectedManagedConnectionEntity
  | ConnectingManagedConnectionEntity
  | AwaitingConfirmationManagedConnectionEntity
  | ReadyManagedConnectionEntity
  | ReadyWithPendingReconnectManagedConnectionEntity
  | ReconnectRequiredManagedConnectionEntity;

/** A connection whose active grant may be used to call the provider. */
export type ServingManagedConnectionEntity =
  | ReadyManagedConnectionEntity
  | ReadyWithPendingReconnectManagedConnectionEntity;

export const isServingManagedConnection = (
  connection: ManagedConnectionEntity,
): connection is ServingManagedConnectionEntity =>
  connection.state === "ready" ||
  connection.state === "ready_with_pending_reconnect";

const invalidRow = (row: ManagedConnectionRowProps, problem: string) =>
  new CoreValidationError(
    `Managed connection ${row.id} in state ${row.state} ${problem}`,
    "MANAGED_CONNECTION_INVALID",
  );

const required = (
  row: ManagedConnectionRowProps,
  name: string,
  value: UuidV7 | null,
): UuidV7 => {
  if (value === null) {
    throw invalidRow(row, `requires ${name}`);
  }
  return value;
};

const assertAbsent = (
  row: ManagedConnectionRowProps,
  fields: Partial<Record<string, UuidV7 | string | null>>,
) => {
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) {
      throw invalidRow(row, `must not have ${name}`);
    }
  }
};

export const ManagedConnectionEntity = {
  /** A new connection starts disconnected; `startConnect` begins the first attempt. */
  create(
    props: CreateManagedConnectionEntityProps,
  ): DisconnectedManagedConnectionEntity {
    return DisconnectedManagedConnectionEntity.create(props);
  },

  /** Rehydrates the class matching `row.state`, rejecting fields that state can't have. */
  rehydrate(row: ManagedConnectionRowProps): ManagedConnectionEntity {
    const {
      state,
      reasonCode,
      activeGrantId,
      candidateGrantId,
      connectedByUserId,
      ...base
    } = row;
    switch (state) {
      case "disconnected":
        assertAbsent(row, {
          activeGrantId,
          candidateGrantId,
          connectedByUserId,
        });
        return DisconnectedManagedConnectionEntity.rehydrate({
          ...base,
          reasonCode,
        });
      case "connecting":
        assertAbsent(row, {
          reasonCode,
          activeGrantId,
          candidateGrantId,
          connectedByUserId,
        });
        return ConnectingManagedConnectionEntity.rehydrate(base);
      case "awaiting_confirmation":
        assertAbsent(row, { reasonCode, activeGrantId, connectedByUserId });
        return AwaitingConfirmationManagedConnectionEntity.rehydrate({
          ...base,
          candidateGrantId: required(row, "candidateGrantId", candidateGrantId),
        });
      case "ready":
        assertAbsent(row, { reasonCode, candidateGrantId });
        return ReadyManagedConnectionEntity.rehydrate({
          ...base,
          activeGrantId: required(row, "activeGrantId", activeGrantId),
          connectedByUserId: required(
            row,
            "connectedByUserId",
            connectedByUserId,
          ),
        });
      case "ready_with_pending_reconnect":
        assertAbsent(row, { reasonCode });
        return ReadyWithPendingReconnectManagedConnectionEntity.rehydrate({
          ...base,
          activeGrantId: required(row, "activeGrantId", activeGrantId),
          candidateGrantId: required(row, "candidateGrantId", candidateGrantId),
          connectedByUserId: required(
            row,
            "connectedByUserId",
            connectedByUserId,
          ),
        });
      case "reconnect_required":
        if (reasonCode === null) {
          throw invalidRow(row, "requires reasonCode");
        }
        return ReconnectRequiredManagedConnectionEntity.rehydrate({
          ...base,
          activeGrantId: required(row, "activeGrantId", activeGrantId),
          candidateGrantId,
          connectedByUserId: required(
            row,
            "connectedByUserId",
            connectedByUserId,
          ),
          reasonCode,
        });
    }
  },
};
