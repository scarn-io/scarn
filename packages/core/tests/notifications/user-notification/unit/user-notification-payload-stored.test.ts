import { describe, expect } from "bun:test";
import {
  readStoredUserNotificationPayload,
  withStoredUserNotificationPayloadKeys,
} from "@/notifications/user-notification/contracts/user-notification-payload-stored";
import { concurrentTest } from "tests/utils";
import payloadFixtures from "../fixtures/payload.json";

describe("user_notifications.payload_json stored reader", () => {
  for (const fixture of payloadFixtures) {
    concurrentTest(`reads the ${fixture.name} fixture`, () => {
      expect(
        readStoredUserNotificationPayload(fixture.payloadJson) as unknown,
      ).toEqual({ success: true, value: fixture.payloadJson });
    });
  }

  for (const [name, payloadJson] of [
    ["a non-string conversationId", { conversationId: 42 }],
    ["an array", [{ conversationId: "a" }]],
    ["a string", "payload"],
  ] as const) {
    concurrentTest(`reports ${name} as unreadable`, () => {
      expect(readStoredUserNotificationPayload(payloadJson).success).toBe(
        false,
      );
    });
  }

  concurrentTest("sets new keys over the stored ones", () => {
    expect(
      withStoredUserNotificationPayloadKeys(
        { category: "question", response: "old" },
        { response: { answer: "new" } },
      ),
    ).toEqual({ category: "question", response: { answer: "new" } });
  });

  concurrentTest("sets new keys on no payload", () => {
    expect(
      withStoredUserNotificationPayloadKeys(null, { response: "new" }),
    ).toEqual({ response: "new" });
  });

  concurrentTest("drops the keys of an unreadable payload", () => {
    expect(
      withStoredUserNotificationPayloadKeys(
        { conversationId: 42, category: "question" },
        { response: "new" },
      ),
    ).toEqual({ response: "new" });
  });
});
