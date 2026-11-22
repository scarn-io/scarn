import type {
  AnalyticsEventName,
  AnalyticsEventProperties,
} from "@scarn/observability/analytics/events";
import type { AnalyticsPort } from "./analytics-port";

export type RecordedAnalyticsCall = {
  [E in AnalyticsEventName]: {
    distinctId: string;
    event: E;
    properties: AnalyticsEventProperties[E];
  };
}[AnalyticsEventName];

/**
 * Test-only `AnalyticsPort` that keeps every capture in memory. Inject it via
 * `createAppContext({ analytics })`; production code never imports this module.
 */
export class RecordingAnalytics implements AnalyticsPort {
  public readonly calls: RecordedAnalyticsCall[] = [];

  public capture<E extends AnalyticsEventName>(
    distinctId: string,
    event: E,
    properties: AnalyticsEventProperties[E],
  ): void {
    this.calls.push({ distinctId, event, properties } as RecordedAnalyticsCall);
  }

  public callsFor<E extends AnalyticsEventName>(
    event: E,
  ): Extract<RecordedAnalyticsCall, { event: E }>[] {
    return this.calls.filter(
      (call): call is Extract<RecordedAnalyticsCall, { event: E }> =>
        call.event === event,
    );
  }
}
