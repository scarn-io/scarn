import { describe, expect } from "bun:test";
import { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import { concurrentTest } from "tests/utils";

describe("UserNotificationEntity.deriveStatus", () => {
  concurrentTest("pending with no deliveries", () => {
    expect(UserNotificationEntity.deriveStatus([])).toBe("pending");
  });

  concurrentTest("pending while any delivery is still pending", () => {
    expect(UserNotificationEntity.deriveStatus(["sent", "pending"])).toBe(
      "pending",
    );
  });

  concurrentTest("delivered when all attempted channels succeeded", () => {
    expect(UserNotificationEntity.deriveStatus(["sent", "sent"])).toBe(
      "delivered",
    );
  });

  concurrentTest("partially_delivered when some sent and some suppressed", () => {
    expect(UserNotificationEntity.deriveStatus(["sent", "suppressed"])).toBe(
      "partially_delivered",
    );
  });

  concurrentTest("partially_delivered when some sent and some failed", () => {
    expect(UserNotificationEntity.deriveStatus(["sent", "failed"])).toBe(
      "partially_delivered",
    );
  });

  concurrentTest("suppressed when all channels suppressed", () => {
    expect(UserNotificationEntity.deriveStatus(["suppressed"])).toBe(
      "suppressed",
    );
  });

  concurrentTest("failed when all attempts failed", () => {
    expect(UserNotificationEntity.deriveStatus(["failed"])).toBe("failed");
  });
});
