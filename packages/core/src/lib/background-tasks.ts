import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "@scarn/observability/logging";

/**
 * Work that must finish after the response has been handed back, such as
 * deleting a relayed call's operation row once its stream ends. The API is
 * host-agnostic, so each HTTP entry point says how its host keeps the
 * invocation alive for such work: `after()` on Vercel, `ctx.waitUntil` on
 * Workers. A long-lived process (Bun, tests) needs nothing.
 *
 * A task is registered as a promise while the request is still being
 * handled, even if it only settles minutes later. Its continuations keep the
 * request's async context, so a per-request database client stays bound.
 */
export type BackgroundTaskHost = {
  waitUntil(task: Promise<unknown>): void;
};

const hostStorage = new AsyncLocalStorage<BackgroundTaskHost>();

/** Runs `fn` with `host` receiving every task scheduled while it runs. */
export const runWithBackgroundTaskHost = <T>(
  host: BackgroundTaskHost,
  fn: () => T,
): T => hostStorage.run(host, fn);

/**
 * Hands `task` to the current host, or lets it run detached outside any
 * host scope. A rejection is logged, never thrown.
 */
export const scheduleBackgroundTask = (
  task: Promise<unknown>,
  logger: Logger,
): void => {
  const guarded = (async () => {
    try {
      await task;
    } catch (error) {
      logger.error({ err: error }, "background task failed");
    }
  })();
  hostStorage.getStore()?.waitUntil(guarded);
};
