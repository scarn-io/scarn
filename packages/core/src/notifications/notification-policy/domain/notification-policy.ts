import type {
  NotificationPriority,
  UserNotificationKind,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
import type { NotificationChannel } from "@scarn/core/notifications/notification-delivery/contracts/notification-delivery-contracts";
import type { NotificationRuleEntity } from "./notification-rule-entity";

export const NOTIFICATION_PRIORITY_ORDER: Record<NotificationPriority, number> =
  {
    low: 0,
    normal: 1,
    high: 2,
    urgent: 3,
  };

const ALL_CHANNELS: readonly NotificationChannel[] = [
  "in_app",
  "work_item_platform_comment",
  "email",
  "slack",
];

export type ChannelDecision = {
  channel: NotificationChannel;
  allowed: boolean;
  suppressionReason: string | null;
};

export type PolicyInput = {
  kind: UserNotificationKind;
  priority: NotificationPriority;
  suggestedChannels: readonly NotificationChannel[];
  rules: readonly NotificationRuleEntity[];
};

/**
 * Default channel behavior when no project rule exists:
 * - in_app is always allowed (the escape hatch: never lose a notification).
 * - all other channels are suppressed until explicitly enabled by a rule.
 */
const defaultAllows = (channel: NotificationChannel): boolean =>
  channel === "in_app";

/**
 * Decide which channels a notification may be delivered to.
 *
 * Candidate channels = in_app (always considered) ∪ agent-suggested channels ∪
 * channels that have an enabled rule for this kind. Each candidate is then
 * checked against the most specific (kind, channel) rule.
 */
export const evaluateNotificationPolicy = (
  input: PolicyInput,
): ChannelDecision[] => {
  const ruleFor = (channel: NotificationChannel): NotificationRuleEntity | undefined =>
    input.rules.find((r) => r.kind === input.kind && r.channel === channel);

  const candidates = new Set<NotificationChannel>(["in_app"]);
  for (const c of input.suggestedChannels) candidates.add(c);
  for (const r of input.rules) {
    if (r.kind === input.kind && r.enabled) candidates.add(r.channel);
  }

  const priorityRank = NOTIFICATION_PRIORITY_ORDER[input.priority];

  return ALL_CHANNELS.filter((c) => candidates.has(c)).map((channel) => {
    const rule = ruleFor(channel);

    if (!rule) {
      return defaultAllows(channel)
        ? { channel, allowed: true, suppressionReason: null }
        : {
            channel,
            allowed: false,
            suppressionReason: "no_policy_rule",
          };
    }

    if (!rule.enabled) {
      return {
        channel,
        allowed: false,
        suppressionReason: "channel_disabled_by_policy",
      };
    }

    if (
      rule.minPriority !== null &&
      priorityRank < NOTIFICATION_PRIORITY_ORDER[rule.minPriority]
    ) {
      return {
        channel,
        allowed: false,
        suppressionReason: "below_min_priority",
      };
    }

    return { channel, allowed: true, suppressionReason: null };
  });
};
