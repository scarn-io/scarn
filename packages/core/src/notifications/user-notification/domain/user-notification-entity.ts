import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  NotificationAudience,
  NotificationPriority,
  NotificationSource,
  UserNotificationKind,
  UserNotificationStatus,
} from "../contracts/user-notification-contracts";

export type UserNotificationEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  workItemId: UuidV7 | null;
  pipelineExecutionId: UuidV7 | null;
  taskId: UuidV7 | null;
  agentSessionId: UuidV7 | null;
  /** The one person it is for; null for a notification to the whole project. */
  recipientUserId: UuidV7 | null;
  kind: UserNotificationKind;
  audience: NotificationAudience;
  title: string;
  body: string;
  priority: NotificationPriority;
  source: NotificationSource;
  status: UserNotificationStatus;
  payloadJson: AnyJsonObject | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateUserNotificationEntityProps = Omit<
  UserNotificationEntityProps,
  "id" | "status"
> & {
  id?: UuidV7;
  status?: UserNotificationStatus;
};

/**
 * A delivery outcome, as seen by the notification when recomputing its own
 * status. Decoupled from the delivery entity to keep the dependency direction
 * inward.
 */
export type DeliveryOutcome = "sent" | "failed" | "suppressed" | "pending";

export class UserNotificationEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly workItemId: UuidV7 | null;
  public readonly pipelineExecutionId: UuidV7 | null;
  public readonly taskId: UuidV7 | null;
  public readonly agentSessionId: UuidV7 | null;
  public readonly recipientUserId: UuidV7 | null;
  public readonly kind: UserNotificationKind;
  public readonly audience: NotificationAudience;
  public readonly title: string;
  public readonly body: string;
  public readonly priority: NotificationPriority;
  public readonly source: NotificationSource;
  public readonly status: UserNotificationStatus;
  public readonly payloadJson: AnyJsonObject | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: UserNotificationEntityProps) {
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.workItemId = props.workItemId ? parseUuidV7(props.workItemId) : null;
    this.pipelineExecutionId = props.pipelineExecutionId
      ? parseUuidV7(props.pipelineExecutionId)
      : null;
    this.taskId = props.taskId ? parseUuidV7(props.taskId) : null;
    this.agentSessionId = props.agentSessionId
      ? parseUuidV7(props.agentSessionId)
      : null;
    this.recipientUserId = props.recipientUserId
      ? parseUuidV7(props.recipientUserId)
      : null;
    this.kind = props.kind;
    this.audience = props.audience;
    this.title = props.title;
    this.body = props.body;
    this.priority = props.priority;
    this.source = props.source;
    this.status = props.status;
    this.payloadJson = props.payloadJson;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: CreateUserNotificationEntityProps,
  ): UserNotificationEntity {
    return new UserNotificationEntity({
      ...props,
      id: props.id ?? createUuidV7(),
      status: props.status ?? "pending",
    });
  }

  static rehydrate(props: UserNotificationEntityProps): UserNotificationEntity {
    return new UserNotificationEntity(props);
  }

  /**
   * Derive the aggregate status from its deliveries' outcomes.
   * Pure function so it can be unit-tested without infra.
   */
  static deriveStatus(
    outcomes: readonly DeliveryOutcome[],
  ): UserNotificationStatus {
    if (outcomes.length === 0) return "pending";

    const sent = outcomes.filter((o) => o === "sent").length;
    const failed = outcomes.filter((o) => o === "failed").length;
    const suppressed = outcomes.filter((o) => o === "suppressed").length;
    const pending = outcomes.filter((o) => o === "pending").length;

    if (pending > 0) return "pending";
    if (sent > 0 && (failed > 0 || suppressed > 0))
      return "partially_delivered";
    if (sent > 0) return "delivered";
    if (failed > 0) return "failed";
    return "suppressed";
  }

  /** A person sees notifications addressed to them and those to the whole project. */
  isVisibleTo(userId: UuidV7): boolean {
    return this.recipientUserId === null || this.recipientUserId === userId;
  }

  withStatus(
    status: UserNotificationStatus,
    updatedAt: Date,
  ): UserNotificationEntity {
    return new UserNotificationEntity({ ...this.toJSON(), status, updatedAt });
  }

  withPayload(
    payloadJson: AnyJsonObject | null,
    updatedAt: Date,
  ): UserNotificationEntity {
    return new UserNotificationEntity({
      ...this.toJSON(),
      payloadJson,
      updatedAt,
    });
  }

  toJSON(): UserNotificationEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      workItemId: this.workItemId,
      pipelineExecutionId: this.pipelineExecutionId,
      taskId: this.taskId,
      agentSessionId: this.agentSessionId,
      recipientUserId: this.recipientUserId,
      kind: this.kind,
      audience: this.audience,
      title: this.title,
      body: this.body,
      priority: this.priority,
      source: this.source,
      status: this.status,
      payloadJson: this.payloadJson,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
