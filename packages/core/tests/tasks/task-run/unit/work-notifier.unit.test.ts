import { describe, expect, test } from "bun:test";
import { noopLogger } from "@scarn/observability/logging";
import {
  AsyncLocalWorkNotifier,
  runWithWorkNotifyScope,
} from "@/tasks/task-run/application/work-notifier";
import type { WorkSignal } from "@/tasks/task-run/application/work-signal";

const recordingSignal = () => {
  const notified: string[] = [];
  const signal: WorkSignal = {
    notify: (projectId) => {
      notified.push(projectId);
      return Promise.resolve();
    },
  };
  return { signal, notified };
};

const notifier = new AsyncLocalWorkNotifier(noopLogger);

const tick = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

describe("runWithWorkNotifyScope", () => {
  test("notifies once per distinct project after fn settles", async () => {
    const { signal, notified } = recordingSignal();

    await runWithWorkNotifyScope(signal, noopLogger, async () => {
      notifier.enqueued("p1");
      await tick();
      notifier.enqueued("p2");
      notifier.enqueued("p1");
      expect(notified).toEqual([]);
    });

    expect(notified.sort()).toEqual(["p1", "p2"]);
  });

  test("does not notify when nothing was enqueued", async () => {
    const { signal, notified } = recordingSignal();

    await runWithWorkNotifyScope(signal, noopLogger, () => Promise.resolve());

    expect(notified).toEqual([]);
  });

  test("flushes when fn throws and rethrows the same error", async () => {
    const { signal, notified } = recordingSignal();
    const error = new Error("rolled back");

    const run = runWithWorkNotifyScope(signal, noopLogger, async () => {
      notifier.enqueued("p1");
      await tick();
      throw error;
    });

    let caught;
    try {
      await run;
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
    expect(notified).toEqual(["p1"]);
  });

  test("returns fn's result unchanged", async () => {
    const { signal } = recordingSignal();
    const value = { id: 1 };

    const result = await runWithWorkNotifyScope(signal, noopLogger, () =>
      Promise.resolve(value),
    );

    expect(result).toBe(value);
  });

  test("swallows a rejecting notify", async () => {
    const signal: WorkSignal = {
      notify: () => Promise.reject(new Error("boom")),
    };

    const result = await runWithWorkNotifyScope(signal, noopLogger, () => {
      notifier.enqueued("p1");
      return Promise.resolve("ok");
    });

    expect(result).toBe("ok");
  });

  test("concurrent scopes do not leak into each other", async () => {
    const a = recordingSignal();
    const b = recordingSignal();

    await Promise.all([
      runWithWorkNotifyScope(a.signal, noopLogger, async () => {
        notifier.enqueued("a1");
        await tick();
        await tick();
        notifier.enqueued("a2");
      }),
      runWithWorkNotifyScope(b.signal, noopLogger, async () => {
        await tick();
        notifier.enqueued("b1");
      }),
    ]);

    expect(a.notified.sort()).toEqual(["a1", "a2"]);
    expect(b.notified).toEqual(["b1"]);
  });

  test("a nested scope flushes its own projects only", async () => {
    const outer = recordingSignal();
    const inner = recordingSignal();

    await runWithWorkNotifyScope(outer.signal, noopLogger, async () => {
      notifier.enqueued("outer-before");
      await runWithWorkNotifyScope(inner.signal, noopLogger, () => {
        notifier.enqueued("inner");
        return Promise.resolve();
      });
      expect(inner.notified).toEqual(["inner"]);
      notifier.enqueued("outer-after");
    });

    expect(outer.notified.sort()).toEqual(["outer-after", "outer-before"]);
  });
});

describe("AsyncLocalWorkNotifier", () => {
  test("enqueued outside a scope is a no-op", async () => {
    const { signal, notified } = recordingSignal();

    expect(() => {
      notifier.enqueued("p1");
    }).not.toThrow();
    await runWithWorkNotifyScope(signal, noopLogger, () => Promise.resolve());

    expect(notified).toEqual([]);
  });
});
