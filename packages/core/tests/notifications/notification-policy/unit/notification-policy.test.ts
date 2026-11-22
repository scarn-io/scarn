import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { NotificationRuleEntity } from "@/notifications/notification-policy/domain/notification-rule-entity";
import { evaluateNotificationPolicy } from "@/notifications/notification-policy/domain/notification-policy";
import type { NotificationChannel } from "@/notifications/notification-delivery/contracts/notification-delivery-contracts";
import { concurrentTest } from "tests/utils";

const ruleFor = (input: {
  channel: NotificationChannel;
  enabled: boolean;
  minPriority?: "low" | "normal" | "high" | "urgent" | null;
}) =>
  NotificationRuleEntity.create({
    projectId: createUuidV7(),
    kind: "feedback_request",
    channel: input.channel,
    enabled: input.enabled,
    minPriority: input.minPriority ?? null,
    conditionsJson: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const decisionFor = (
  decisions: ReturnType<typeof evaluateNotificationPolicy>,
  channel: NotificationChannel,
) => decisions.find((d) => d.channel === channel);

describe("evaluateNotificationPolicy", () => {
  concurrentTest("in_app is always allowed by default (escape hatch)", () => {
    const decisions = evaluateNotificationPolicy({
      kind: "feedback_request",
      priority: "normal",
      suggestedChannels: [],
      rules: [],
    });

    expect(decisionFor(decisions, "in_app")?.allowed).toBe(true);
  });

  concurrentTest(
    "agent-suggested work_item_platform_comment is suppressed when no rule exists",
    () => {
      const decisions = evaluateNotificationPolicy({
        kind: "feedback_request",
        priority: "high",
        suggestedChannels: ["work_item_platform_comment"],
        rules: [],
      });

      const workItemComment = decisionFor(decisions, "work_item_platform_comment");
      expect(workItemComment?.allowed).toBe(false);
      expect(workItemComment?.suppressionReason).toBe("no_policy_rule");
    },
  );

  concurrentTest(
    "enabled work_item_platform_comment rule allows delivery when priority meets the minimum",
    () => {
      const decisions = evaluateNotificationPolicy({
        kind: "feedback_request",
        priority: "high",
        suggestedChannels: ["work_item_platform_comment"],
        rules: [
          ruleFor({ channel: "work_item_platform_comment", enabled: true, minPriority: "high" }),
        ],
      });

      expect(decisionFor(decisions, "work_item_platform_comment")?.allowed).toBe(true);
    },
  );

  concurrentTest("work_item_platform_comment rule suppresses below the minimum priority", () => {
    const decisions = evaluateNotificationPolicy({
      kind: "feedback_request",
      priority: "normal",
      suggestedChannels: ["work_item_platform_comment"],
      rules: [
        ruleFor({ channel: "work_item_platform_comment", enabled: true, minPriority: "high" }),
      ],
    });

    const workItemComment = decisionFor(decisions, "work_item_platform_comment");
    expect(workItemComment?.allowed).toBe(false);
    expect(workItemComment?.suppressionReason).toBe("below_min_priority");
  });

  concurrentTest("disabled rule suppresses the channel", () => {
    const decisions = evaluateNotificationPolicy({
      kind: "feedback_request",
      priority: "urgent",
      suggestedChannels: ["work_item_platform_comment"],
      rules: [ruleFor({ channel: "work_item_platform_comment", enabled: false })],
    });

    const workItemComment = decisionFor(decisions, "work_item_platform_comment");
    expect(workItemComment?.allowed).toBe(false);
    expect(workItemComment?.suppressionReason).toBe("channel_disabled_by_policy");
  });
});
