import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { NotificationDeliveryEntity } from "@/notifications/notification-delivery/domain/notification-delivery-entity";

const buildEntity = (): NotificationDeliveryEntity =>
  NotificationDeliveryEntity.create({
    notificationId: createUuidV7(),
    channel: "work_item_platform_comment",
    status: "pending",
    suppressionReason: null,
    externalUrl: null,
    externalId: null,
  });

describe("NotificationDeliveryEntity.markSuppressed", () => {
  concurrentTest(
    "returns a new entity with status suppressed and the given reason",
    () => {
      const original = buildEntity();

      const suppressed = original.markSuppressed("no_policy_rule");

      expect(suppressed.status).toBe("suppressed");
      expect(suppressed.suppressionReason).toBe("no_policy_rule");
    },
  );

  concurrentTest(
    "accepts null (the exact call pattern rejectCommentDraft uses)",
    () => {
      const original = buildEntity();

      const suppressed = original.markSuppressed(null);

      expect(suppressed.status).toBe("suppressed");
      expect(suppressed.suppressionReason).toBeNull();
    },
  );

  concurrentTest(
    "preserves every other field unchanged from the original entity",
    () => {
      const original = NotificationDeliveryEntity.rehydrate({
        id: createUuidV7(),
        notificationId: createUuidV7(),
        channel: "work_item_platform_comment",
        status: "pending",
        suppressionReason: null,
        externalUrl: "https://example.test/existing",
        externalId: "existing-id",
        artifactResolutionJson: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        sentAt: null,
      });

      const suppressed = original.markSuppressed("rejected_by_user");

      expect(suppressed.id).toBe(original.id);
      expect(suppressed.notificationId).toBe(original.notificationId);
      expect(suppressed.channel).toBe(original.channel);
      expect(suppressed.externalUrl).toBe(original.externalUrl);
      expect(suppressed.externalId).toBe(original.externalId);
      expect(suppressed.createdAt).toBe(original.createdAt);
      expect(suppressed.sentAt).toBe(original.sentAt);
    },
  );

  concurrentTest("does not mutate the original entity", () => {
    const original = buildEntity();
    const originalStatus = original.status;
    const originalSuppressionReason = original.suppressionReason;

    original.markSuppressed("no_policy_rule");

    expect(original.status).toBe(originalStatus);
    expect(original.suppressionReason).toBe(originalSuppressionReason);
  });
});

describe("NotificationDeliveryEntity.markSent", () => {
  concurrentTest(
    "returns a new entity with status sent, external ids, and sentAt set",
    () => {
      const original = buildEntity();
      const sentAt = new Date("2024-06-01T00:00:00.000Z");

      const sent = original.markSent(
        { externalId: "gh-1", externalUrl: "https://example.test/gh-1" },
        sentAt,
      );

      expect(sent.status).toBe("sent");
      expect(sent.externalId).toBe("gh-1");
      expect(sent.externalUrl).toBe("https://example.test/gh-1");
      expect(sent.sentAt).toBe(sentAt);
      expect(original.status).toBe("pending");
    },
  );
});

describe("NotificationDeliveryEntity.markFailed", () => {
  concurrentTest(
    "returns a new entity with status failed and the suppressionReason set to the failure message",
    () => {
      const original = buildEntity();

      const failed = original.markFailed("delivery_failed");

      expect(failed.status).toBe("failed");
      expect(failed.suppressionReason).toBe("delivery_failed");
      expect(original.status).toBe("pending");
    },
  );
});
