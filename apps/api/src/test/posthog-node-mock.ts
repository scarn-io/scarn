/**
 * Shared fake for `posthog-node`, installed via a bun test preload
 * (see apps/api/bunfig.toml).
 *
 * WHY A PRELOAD: `@scarn/observability/analytics/server` binds the real `PostHog` class from
 * `posthog-node` the first time it is evaluated. In a single `bun test` run the
 * module graph is shared and persistent across files, so whichever test file is
 * evaluated first (directly, or transitively via importing the timing plugin
 * which imports analytics/server) locks in the real `posthog-node` — after which
 * a per-file `mock.module("posthog-node", ...)` is too late and has no effect
 * (analytics/server keeps calling the real client, which attempts real network
 * flushes). Registering this fake in a preload guarantees it is in place BEFORE
 * any test module — and therefore before analytics/server — is evaluated, making
 * the analytics integration test order-independent.
 */
import { mock } from "bun:test";

export type PosthogCaptureArgs = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};

/**
 * Records every `capture()` call routed through the fake PostHog client. Tests
 * clear this (e.g. in `beforeEach`) and assert against it.
 */
export const posthogCaptureCalls: PosthogCaptureArgs[] = [];

class FakePostHog {
  capture(args: PosthogCaptureArgs): void {
    posthogCaptureCalls.push(args);
  }

  captureException(): void {
    // no-op for tests
  }

  identify(): void {
    // no-op for tests
  }

  on(): () => void {
    return () => undefined;
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

void mock.module("posthog-node", () => ({ PostHog: FakePostHog }));
