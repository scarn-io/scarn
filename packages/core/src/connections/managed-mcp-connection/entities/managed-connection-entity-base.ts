import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";

export const managedConnectionStateValues = [
  "disconnected",
  "connecting",
  "awaiting_confirmation",
  "ready",
  "ready_with_pending_reconnect",
  "reconnect_required",
] as const;

export type ManagedConnectionState =
  (typeof managedConnectionStateValues)[number];

/**
 * Why a connection is in its current state. A closed list, so nothing a
 * provider sends can end up in the row or an event.
 */
export const managedConnectionReasonCodeValues = [
  "attempt_expired",
  "candidate_expired",
  "candidate_cancelled",
  "refresh_failed",
  "grant_expired",
  "client_configuration",
] as const;

export type ManagedConnectionReasonCode =
  (typeof managedConnectionReasonCodeValues)[number];

export const isManagedConnectionReasonCode = (
  value: string,
): value is ManagedConnectionReasonCode =>
  (managedConnectionReasonCodeValues as readonly string[]).includes(value);

export type ManagedConnectionTransition =
  | "startConnect"
  | "startReconnect"
  | "attachCandidate"
  | "confirmCandidate"
  | "cancelCandidate"
  | "expire"
  | "requireReconnect"
  | "disconnect";

/** The fields every managed connection carries whatever its state. */
export type ManagedConnectionEntityBaseProps = {
  id: UuidV7;
  projectId: UuidV7;
  /** What `auth: { connection }` refers to; unique per project. */
  name: string;
  label: string;
  /** The preset key the connection was created from, if any. */
  preset: string | null;
  server: ManagedConnectionServer;
  /** Goes up only when the grant the connection serves changes. */
  generation: number;
  /** Compare-and-set counter: goes up on every transition. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The flat, nullable `managed_mcp_connections` row shape. Only `toJSON()` and
 * `ManagedConnectionEntity.rehydrate` see it.
 */
export type ManagedConnectionRowProps = ManagedConnectionEntityBaseProps & {
  state: ManagedConnectionState;
  reasonCode: ManagedConnectionReasonCode | null;
  activeGrantId: UuidV7 | null;
  candidateGrantId: UuidV7 | null;
  connectedByUserId: UuidV7 | null;
};

export type ConfirmCandidateInput = {
  /** The fingerprint of the stored candidate grant, computed by the caller. */
  candidateFingerprint: string;
  confirmedByUserId: UuidV7;
  now: Date;
};

const assertCounter = (name: string, value: number) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new CoreValidationError(
      `Managed connection ${name} must be a non-negative integer`,
      "MANAGED_CONNECTION_INVALID",
    );
  }
};

export const managedConnectionCandidateMismatch = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_CANDIDATE_MISMATCH",
    message:
      "The candidate grant changed since it was shown. Review it again before confirming.",
    status: 409,
  });

/**
 * Shared fields and the transition surface of a managed connection. Every
 * transition is declared here and rejects by default; each state's class
 * overrides only the transitions that are legal from it. Every transition
 * bumps `version`; only replacing a grant and disconnecting bump
 * `generation`.
 */
export abstract class ManagedConnectionEntityBase {
  public abstract readonly state: ManagedConnectionState;
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly name: string;
  public readonly label: string;
  public readonly preset: string | null;
  public readonly server: ManagedConnectionServer;
  public readonly generation: number;
  public readonly version: number;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  protected constructor(props: ManagedConnectionEntityBaseProps) {
    assertCounter("generation", props.generation);
    assertCounter("version", props.version);
    this.id = props.id;
    this.projectId = props.projectId;
    this.name = props.name;
    this.label = props.label;
    this.preset = props.preset;
    this.server = props.server;
    this.generation = props.generation;
    this.version = props.version;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /* eslint-disable @typescript-eslint/no-unused-vars -- each state overrides only its legal transitions */
  startConnect(_now: Date): ManagedConnectionEntity {
    return this.reject("startConnect");
  }

  startReconnect(_now: Date): ManagedConnectionEntity {
    return this.reject("startReconnect");
  }

  attachCandidate(
    _candidateGrantId: UuidV7,
    _now: Date,
  ): ManagedConnectionEntity {
    return this.reject("attachCandidate");
  }

  confirmCandidate(
    _candidateGrantId: UuidV7,
    _fingerprint: string,
    _input: ConfirmCandidateInput,
  ): ManagedConnectionEntity {
    return this.reject("confirmCandidate");
  }

  cancelCandidate(
    _candidateGrantId: UuidV7,
    _now: Date,
  ): ManagedConnectionEntity {
    return this.reject("cancelCandidate");
  }

  /** The pending attempt or candidate ran past its 10-minute window. */
  expire(_now: Date): ManagedConnectionEntity {
    return this.reject("expire");
  }

  requireReconnect(
    _reasonCode: ManagedConnectionReasonCode,
    _now: Date,
  ): ManagedConnectionEntity {
    return this.reject("requireReconnect");
  }

  disconnect(_now: Date): ManagedConnectionEntity {
    return this.reject("disconnect");
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  /** The ID of the grant waiting for confirmation, if any. */
  abstract get pendingCandidateGrantId(): UuidV7 | null;

  /** The ID of the grant the connection serves, if any. */
  abstract get servingGrantId(): UuidV7 | null;

  abstract toJSON(): ManagedConnectionRowProps;

  protected nextProps(
    now: Date,
    { bumpGeneration }: { bumpGeneration: boolean },
  ): ManagedConnectionEntityBaseProps {
    return {
      ...this.baseJSON(),
      generation: bumpGeneration ? this.generation + 1 : this.generation,
      version: this.version + 1,
      updatedAt: now,
    };
  }

  protected assertCandidate(
    expectedCandidateGrantId: UuidV7,
    candidateGrantId: UuidV7,
  ): void {
    if (expectedCandidateGrantId !== candidateGrantId) {
      throw managedConnectionCandidateMismatch();
    }
  }

  protected assertConfirmable(
    expectedCandidateGrantId: UuidV7,
    candidateGrantId: UuidV7,
    fingerprint: string,
    input: ConfirmCandidateInput,
  ): void {
    this.assertCandidate(expectedCandidateGrantId, candidateGrantId);
    if (fingerprint !== input.candidateFingerprint) {
      throw managedConnectionCandidateMismatch();
    }
  }

  protected baseJSON(): ManagedConnectionEntityBaseProps {
    return {
      id: this.id,
      projectId: this.projectId,
      name: this.name,
      label: this.label,
      preset: this.preset,
      server: this.server,
      generation: this.generation,
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private reject(transition: ManagedConnectionTransition): never {
    throw new CoreError({
      code: "MANAGED_CONNECTION_STATE_CONFLICT",
      message: `Cannot ${transition} a managed connection that is ${this.state}`,
      status: 409,
      meta: { transition, state: this.state },
    });
  }
}
