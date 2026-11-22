import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";

export const agentSessionStatusValues = ["running", "ended", "failed"] as const;

export type AgentSessionStatus = (typeof agentSessionStatusValues)[number];

export type AgentSessionEntityProps = {
  id: UuidV7;
  taskRunId: UuidV7;
  conversationRootId: UuidV7 | null;
  parentAgentSessionId?: UuidV7 | null | undefined;
  provider: string;
  externalSessionId: string;
  status: AgentSessionStatus;
  startedAt: Date | string;
  endedAt?: Date | string | null | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateRootAgentSessionProps = {
  id?: UuidV7 | undefined;
  taskRunId: UuidV7;
  parentAgentSessionId?: UuidV7 | null | undefined;
  provider: string;
  externalSessionId: string;
  startedAt: Date;
};

export type CreateContinuationAgentSessionProps =
  CreateRootAgentSessionProps & {
    conversationRootId: UuidV7;
  };

/**
 * One external agent session in one container, owned by one Task (D-11). A
 * conversation that outlives a container is a chain of sessions sharing
 * `conversationRootId`; the root session points at itself. The root id is
 * nullable only because deleting the root's Task sets it null (P-1).
 */
export class AgentSessionEntity {
  public readonly id: UuidV7;
  public readonly taskRunId: UuidV7;
  public readonly conversationRootId: UuidV7 | null;
  public readonly parentAgentSessionId: UuidV7 | null;
  public readonly provider: string;
  public readonly externalSessionId: string;
  public readonly status: AgentSessionStatus;
  public readonly startedAt: Date;
  public readonly endedAt: Date | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: AgentSessionEntityProps) {
    const provider = props.provider.trim();
    const externalSessionId = props.externalSessionId.trim();
    const startedAt = normalizeDate(props.startedAt);
    const endedAt = normalizeDate(props.endedAt) ?? null;

    if (!provider) {
      throw new CoreValidationError(
        "Agent session provider is required",
        "AGENT_SESSION_PROVIDER_REQUIRED",
      );
    }

    if (!externalSessionId) {
      throw new CoreValidationError(
        "Agent session external session id is required",
        "AGENT_SESSION_EXTERNAL_SESSION_ID_REQUIRED",
      );
    }

    if (!startedAt) {
      throw new CoreValidationError(
        "Agent session startedAt must be a valid date",
        "AGENT_SESSION_STARTED_AT_INVALID",
      );
    }

    if ((props.status === "running") !== (endedAt === null)) {
      throw new CoreValidationError(
        "A running agent session has no endedAt; an ended or failed one has one",
        "AGENT_SESSION_ENDED_AT_MISMATCH",
      );
    }

    if (endedAt && endedAt.getTime() < startedAt.getTime()) {
      throw new CoreValidationError(
        "Agent session endedAt must not be before startedAt",
        "AGENT_SESSION_ENDED_AT_BEFORE_STARTED_AT",
      );
    }

    const id = parseUuidV7(props.id);
    const parentAgentSessionId = props.parentAgentSessionId
      ? parseUuidV7(props.parentAgentSessionId)
      : null;

    if (parentAgentSessionId === id) {
      throw new CoreValidationError(
        "An agent session cannot be its own parent",
        "AGENT_SESSION_PARENT_INVALID",
      );
    }

    this.id = id;
    this.taskRunId = parseUuidV7(props.taskRunId);
    this.conversationRootId = props.conversationRootId
      ? parseUuidV7(props.conversationRootId)
      : null;
    this.parentAgentSessionId = parentAgentSessionId;
    this.provider = provider;
    this.externalSessionId = externalSessionId;
    this.status = props.status;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  /** Starts a new conversation: the session is its own conversation root. */
  static createRoot(props: CreateRootAgentSessionProps): AgentSessionEntity {
    const id = props.id ?? createUuidV7();
    return new AgentSessionEntity({
      ...props,
      id,
      conversationRootId: id,
      status: "running",
      endedAt: null,
    });
  }

  /** Continues an existing conversation in a new container. */
  static createContinuation(
    props: CreateContinuationAgentSessionProps,
  ): AgentSessionEntity {
    const id = props.id ?? createUuidV7();
    if (props.conversationRootId === id) {
      throw new CoreValidationError(
        "A continuation must point at an earlier conversation root",
        "AGENT_SESSION_CONVERSATION_ROOT_INVALID",
      );
    }
    return new AgentSessionEntity({
      ...props,
      id,
      status: "running",
      endedAt: null,
    });
  }

  static rehydrate(props: AgentSessionEntityProps): AgentSessionEntity {
    return new AgentSessionEntity(props);
  }

  end(now: Date): AgentSessionEntity {
    return this.finish("ended", now);
  }

  fail(now: Date): AgentSessionEntity {
    return this.finish("failed", now);
  }

  private finish(
    status: Exclude<AgentSessionStatus, "running">,
    now: Date,
  ): AgentSessionEntity {
    if (this.status !== "running") {
      throw new CoreValidationError(
        `Agent session ${this.id} is already ${this.status}`,
        "AGENT_SESSION_NOT_RUNNING",
      );
    }
    return new AgentSessionEntity({
      ...this.toJSON(),
      status,
      endedAt: now,
      updatedAt: now,
    });
  }

  toJSON(): AgentSessionEntityProps {
    return {
      id: this.id,
      taskRunId: this.taskRunId,
      conversationRootId: this.conversationRootId,
      parentAgentSessionId: this.parentAgentSessionId,
      provider: this.provider,
      externalSessionId: this.externalSessionId,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
