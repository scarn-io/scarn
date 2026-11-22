import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreError,
  CoreValidationError,
  InvariantViolationError,
} from "@scarn/core/lib/errors";
import {
  isServingManagedConnection,
  type ManagedConnectionEntity,
  type ServingManagedConnectionEntity,
} from "./managed-connection-entity";

/** At most this many relayed calls may be in flight per launch connection (decision 14). */
export const MANAGED_LAUNCH_MAX_OPEN_OPERATIONS = 8;

export const managedLaunchConnectionStateValues = ["open", "closed"] as const;

export type ManagedLaunchConnectionState =
  (typeof managedLaunchConnectionStateValues)[number];

/**
 * Why a run lost the authority its launch pinned. `operation_unknown` is
 * decided by the authority fence from leased operations, never by
 * `authorityLossReason`.
 */
export const managedAuthorityLossReasonValues = [
  "disconnected",
  "replaced",
  "reconnect_required",
  "operation_unknown",
] as const;

export type ManagedAuthorityLossReason =
  (typeof managedAuthorityLossReasonValues)[number];

export type ManagedLaunchConnectionEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  claimTokenDigest: Buffer;
  /** The step's connection-auth entry key this row serves. */
  entryKey: string;
  connectionId: UuidV7;
  /** The connection's generation at registration. */
  generation: number;
  /** The grant the connection served at registration. */
  grantId: UuidV7;
  capabilityDigest: Buffer;
  /** Digest of the `Mcp-Session-Id` the provider returned on `initialize`. */
  mcpSessionIdDigest: Buffer | null;
  state: ManagedLaunchConnectionState;
  createdAt: Date;
  closedAt: Date | null;
};

export type CreateManagedLaunchConnectionEntityProps = {
  projectId: UuidV7;
  taskRunId: UuidV7;
  claimTokenDigest: Buffer;
  entryKey: string;
  connection: ServingManagedConnectionEntity;
  capabilityDigest: Buffer;
  now: Date;
};

const invalid = (message: string) =>
  new CoreValidationError(message, "MANAGED_LAUNCH_CONNECTION_INVALID");

/**
 * One connection a managed launch may use: the run, the claim that
 * registered it, the connection-auth entry it rewrites, and the connection's
 * generation and serving grant pinned at registration. Only digests of the
 * relay capability, claim token and MCP session ID are held. A relay call or
 * seal is valid only while the connection still serves that generation and
 * grant (decision 12).
 */
export class ManagedLaunchConnectionEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly taskRunId: UuidV7;
  public readonly claimTokenDigest: Buffer;
  public readonly entryKey: string;
  public readonly connectionId: UuidV7;
  public readonly generation: number;
  public readonly grantId: UuidV7;
  public readonly capabilityDigest: Buffer;
  public readonly mcpSessionIdDigest: Buffer | null;
  public readonly state: ManagedLaunchConnectionState;
  public readonly createdAt: Date;
  public readonly closedAt: Date | null;

  private constructor(props: ManagedLaunchConnectionEntityProps) {
    if (!props.entryKey.trim()) {
      throw invalid("Managed launch connection requires an entry key");
    }
    if (!Number.isInteger(props.generation) || props.generation < 0) {
      throw invalid(
        "Managed launch connection generation must be a non-negative integer",
      );
    }
    if ((props.state === "closed") !== (props.closedAt !== null)) {
      throw invalid(
        "Managed launch connection closedAt must be set exactly when closed",
      );
    }
    this.id = props.id;
    this.projectId = props.projectId;
    this.taskRunId = props.taskRunId;
    this.claimTokenDigest = props.claimTokenDigest;
    this.entryKey = props.entryKey;
    this.connectionId = props.connectionId;
    this.generation = props.generation;
    this.grantId = props.grantId;
    this.capabilityDigest = props.capabilityDigest;
    this.mcpSessionIdDigest = props.mcpSessionIdDigest;
    this.state = props.state;
    this.createdAt = props.createdAt;
    this.closedAt = props.closedAt;
  }

  /** Opens a launch connection pinned to the serving connection's generation and grant. */
  static create(
    props: CreateManagedLaunchConnectionEntityProps,
  ): ManagedLaunchConnectionEntity {
    const { connection, now, ...rest } = props;
    return new ManagedLaunchConnectionEntity({
      ...rest,
      id: createUuidV7(),
      connectionId: connection.id,
      generation: connection.generation,
      grantId: connection.activeGrantId,
      mcpSessionIdDigest: null,
      state: "open",
      createdAt: now,
      closedAt: null,
    });
  }

  static rehydrate(
    props: ManagedLaunchConnectionEntityProps,
  ): ManagedLaunchConnectionEntity {
    return new ManagedLaunchConnectionEntity(props);
  }

  /** Closing is idempotent: an already-closed row keeps its first `closedAt`. */
  close(now: Date): ManagedLaunchConnectionEntity {
    if (this.state === "closed") {
      return this;
    }
    return new ManagedLaunchConnectionEntity({
      ...this.toJSON(),
      state: "closed",
      closedAt: now,
    });
  }

  /**
   * Records the session the provider created on an `initialize` response.
   * A later `initialize` replaces it: MCP clients re-initialize (OpenCode
   * does so right after listing tools), and only the capability holder can
   * reach `initialize`.
   */
  bindSession(digest: Buffer): ManagedLaunchConnectionEntity {
    if (this.state === "closed") {
      throw new CoreError({
        code: "MANAGED_LAUNCH_CLOSED",
        message: "This managed launch connection is closed",
        status: 409,
      });
    }
    return new ManagedLaunchConnectionEntity({
      ...this.toJSON(),
      mcpSessionIdDigest: digest,
    });
  }

  /**
   * Whether `connection` still holds the authority this launch pinned: it is
   * serving, at the pinned generation, with the pinned grant. Says nothing
   * about whether the launch itself is open.
   */
  authorityLossReason(
    connection: ManagedConnectionEntity,
  ): Exclude<ManagedAuthorityLossReason, "operation_unknown"> | null {
    if (connection.id !== this.connectionId) {
      throw new InvariantViolationError(
        `Managed launch connection ${this.id} was checked against connection ${connection.id}`,
      );
    }
    if (connection.generation !== this.generation) {
      return connection.state === "disconnected" ? "disconnected" : "replaced";
    }
    if (!isServingManagedConnection(connection)) {
      return connection.state === "disconnected"
        ? "disconnected"
        : "reconnect_required";
    }
    if (connection.servingGrantId !== this.grantId) {
      return "replaced";
    }
    return null;
  }

  /** The launch is open and `connection` still holds its pinned authority. */
  isAuthorizedBy(connection: ManagedConnectionEntity): boolean {
    return (
      this.state === "open" && this.authorityLossReason(connection) === null
    );
  }

  toJSON(): ManagedLaunchConnectionEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      taskRunId: this.taskRunId,
      claimTokenDigest: this.claimTokenDigest,
      entryKey: this.entryKey,
      connectionId: this.connectionId,
      generation: this.generation,
      grantId: this.grantId,
      capabilityDigest: this.capabilityDigest,
      mcpSessionIdDigest: this.mcpSessionIdDigest,
      state: this.state,
      createdAt: this.createdAt,
      closedAt: this.closedAt,
    };
  }
}

/** One relayed call, leased until `deadlineAt` (decision 15). */
export type ManagedOperation = {
  id: UuidV7;
  launchConnectionId: UuidV7;
  startedAt: Date;
  deadlineAt: Date;
};

export const createManagedOperation = (input: {
  launchConnectionId: UuidV7;
  startedAt: Date;
  deadlineAt: Date;
}): ManagedOperation => {
  if (input.deadlineAt.getTime() <= input.startedAt.getTime()) {
    throw invalid("A managed operation's deadline must follow its start");
  }
  return { ...input, id: createUuidV7() };
};
