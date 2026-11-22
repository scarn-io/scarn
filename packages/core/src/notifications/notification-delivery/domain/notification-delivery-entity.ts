import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
} from "../contracts/notification-delivery-contracts";

export type NotificationDeliveryEntityProps = {
  id: UuidV7;
  notificationId: UuidV7;
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  suppressionReason: string | null;
  externalUrl: string | null;
  externalId: string | null;
  artifactResolutionJson: AnyJsonObject | null;
  createdAt: Date;
  sentAt: Date | null;
};

export type CreateNotificationDeliveryEntityProps = Omit<
  NotificationDeliveryEntityProps,
  "id" | "createdAt" | "sentAt" | "artifactResolutionJson"
> & {
  id?: UuidV7;
  artifactResolutionJson?: AnyJsonObject | null;
  createdAt?: Date;
  sentAt?: Date | null;
};

export class NotificationDeliveryEntity {
  public readonly id: UuidV7;
  public readonly notificationId: UuidV7;
  public readonly channel: NotificationChannel;
  public readonly status: NotificationDeliveryStatus;
  public readonly suppressionReason: string | null;
  public readonly externalUrl: string | null;
  public readonly externalId: string | null;
  public readonly artifactResolutionJson: AnyJsonObject | null;
  public readonly createdAt: Date;
  public readonly sentAt: Date | null;

  private constructor(props: NotificationDeliveryEntityProps) {
    this.id = parseUuidV7(props.id);
    this.notificationId = parseUuidV7(props.notificationId);
    this.channel = props.channel;
    this.status = props.status;
    this.suppressionReason = props.suppressionReason;
    this.externalUrl = props.externalUrl;
    this.externalId = props.externalId;
    this.artifactResolutionJson = props.artifactResolutionJson;
    this.createdAt = props.createdAt;
    this.sentAt = props.sentAt;
  }

  static create(
    props: CreateNotificationDeliveryEntityProps,
  ): NotificationDeliveryEntity {
    return new NotificationDeliveryEntity({
      ...props,
      id: props.id ?? createUuidV7(),
      artifactResolutionJson: props.artifactResolutionJson ?? null,
      createdAt: props.createdAt ?? new Date(),
      sentAt: props.sentAt ?? null,
    });
  }

  static rehydrate(
    props: NotificationDeliveryEntityProps,
  ): NotificationDeliveryEntity {
    return new NotificationDeliveryEntity(props);
  }

  markSent(
    result: { externalId?: string | null; externalUrl?: string | null },
    sentAt: Date,
  ): NotificationDeliveryEntity {
    return new NotificationDeliveryEntity({
      ...this.toJSON(),
      status: "sent",
      externalId: result.externalId ?? null,
      externalUrl: result.externalUrl ?? null,
      sentAt,
    });
  }

  markFailed(reason: string): NotificationDeliveryEntity {
    return new NotificationDeliveryEntity({
      ...this.toJSON(),
      status: "failed",
      suppressionReason: reason,
    });
  }

  markSuppressed(reason: string | null): NotificationDeliveryEntity {
    return new NotificationDeliveryEntity({
      ...this.toJSON(),
      status: "suppressed",
      suppressionReason: reason,
    });
  }

  withArtifactResolution(
    artifactResolutionJson: AnyJsonObject | null,
  ): NotificationDeliveryEntity {
    return new NotificationDeliveryEntity({
      ...this.toJSON(),
      artifactResolutionJson,
    });
  }

  toJSON(): NotificationDeliveryEntityProps {
    return {
      id: this.id,
      notificationId: this.notificationId,
      channel: this.channel,
      status: this.status,
      suppressionReason: this.suppressionReason,
      externalUrl: this.externalUrl,
      externalId: this.externalId,
      artifactResolutionJson: this.artifactResolutionJson,
      createdAt: this.createdAt,
      sentAt: this.sentAt,
    };
  }
}
