import type {
  AnalyticsEventName,
  AnalyticsEventProperties,
} from "@scarn/observability/analytics/events";

/**
 * Product-analytics sink for server-side funnel events. Use cases and routes
 * call it directly (not through domain-event handlers), and only after the
 * transaction that persisted the reported change has committed — there is no
 * outbox, so a capture inside a transaction could report a rolled-back write.
 *
 * `capture` is fire-and-forget and must never throw.
 */
export interface AnalyticsPort {
  capture<E extends AnalyticsEventName>(
    distinctId: string,
    event: E,
    properties: AnalyticsEventProperties[E],
  ): void;
}

/**
 * For internal callers whose writes must never reach product analytics
 * (demo-account seeding, maintenance scripts).
 */
export const noopAnalytics: AnalyticsPort = {
  capture: () => undefined,
};
