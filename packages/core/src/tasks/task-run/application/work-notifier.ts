import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "@scarn/observability/logging";
import type { WorkSignal } from "./work-signal";

/**
 * Records that a project has newly claimable work. Never does I/O, so it is
 * safe to call inside a transaction: the recorded projects are notified via
 * `WorkSignal` when the enclosing `runWithWorkNotifyScope` ends.
 */
export interface WorkNotifier {
  enqueued(projectId: string): void;
}

const scopeStorage = new AsyncLocalStorage<Set<string>>();

/**
 * Runs `fn` inside a fresh notify scope, then calls `workSignal.notify` once
 * per distinct project recorded during it. Flushes whether `fn` resolves or
 * throws (a spurious notify costs one empty claim; a missed one costs a poll
 * interval), and returns or rethrows `fn`'s outcome unchanged. Notifies run in
 * parallel and rely on `WorkSignal` for the timeout; any rejection is logged
 * and swallowed.
 */
export const runWithWorkNotifyScope = async <T>(
  workSignal: WorkSignal,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T> => {
  const projectIds = new Set<string>();
  try {
    return await scopeStorage.run(projectIds, fn);
  } finally {
    const results = await Promise.allSettled(
      [...projectIds].map((projectId) => workSignal.notify(projectId)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn({ err: result.reason }, "work-signal flush failed");
      }
    }
  }
};

/**
 * `WorkNotifier` backed by the scope opened by `runWithWorkNotifyScope`.
 * Outside a scope the hint is dropped (logged at debug); polling covers it.
 */
export class AsyncLocalWorkNotifier implements WorkNotifier {
  public constructor(private readonly logger: Logger) {}

  public enqueued(projectId: string): void {
    const projectIds = scopeStorage.getStore();
    if (!projectIds) {
      this.logger.debug(
        { projectId },
        "work enqueued outside a notify scope; relying on polling",
      );
      return;
    }
    projectIds.add(projectId);
  }
}
