import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  NotificationPriority,
  UserNotificationKind,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
import type { NotificationChannel } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";

export type NotificationRuleEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  kind: UserNotificationKind;
  channel: NotificationChannel;
  enabled: boolean;
  minPriority: NotificationPriority | null;
  conditionsJson: AnyJsonObject | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateNotificationRuleEntityProps = Omit<
  NotificationRuleEntityProps,
  "id"
> & {
  id?: UuidV7;
};

export class NotificationRuleEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly kind: UserNotificationKind;
  public readonly channel: NotificationChannel;
  public readonly enabled: boolean;
  public readonly minPriority: NotificationPriority | null;
  public readonly conditionsJson: AnyJsonObject | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: NotificationRuleEntityProps) {
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.kind = props.kind;
    this.channel = props.channel;
    this.enabled = props.enabled;
    this.minPriority = props.minPriority;
    this.conditionsJson = props.conditionsJson;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: CreateNotificationRuleEntityProps,
  ): NotificationRuleEntity {
    return new NotificationRuleEntity({
      ...props,
      id: props.id ?? createUuidV7(),
    });
  }

  static rehydrate(
    props: NotificationRuleEntityProps,
  ): NotificationRuleEntity {
    return new NotificationRuleEntity(props);
  }

  toJSON(): NotificationRuleEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      kind: this.kind,
      channel: this.channel,
      enabled: this.enabled,
      minPriority: this.minPriority,
      conditionsJson: this.conditionsJson,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
