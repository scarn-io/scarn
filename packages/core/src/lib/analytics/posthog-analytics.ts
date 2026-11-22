import { capture } from "@scarn/observability/analytics/server";
import type {
  AnalyticsEventName,
  AnalyticsEventProperties,
} from "@scarn/observability/analytics/events";
import type { Logger } from "@scarn/observability/logging";
import type { AnalyticsPort } from "./analytics-port";

/**
 * `AnalyticsPort` over the process-wide posthog-node client. A no-op until the
 * host process calls `initServerAnalytics()` (`apps/api/src/analytics.ts`), so
 * tests and scripts that never initialize PostHog send nothing.
 */
export class PostHogAnalytics implements AnalyticsPort {
  public constructor(private readonly logger: Logger) {}

  public capture<E extends AnalyticsEventName>(
    distinctId: string,
    event: E,
    properties: AnalyticsEventProperties[E],
  ): void {
    try {
      capture(distinctId, event, properties);
    } catch (err) {
      this.logger.warn({ err, event }, "analytics capture failed");
    }
  }
}
