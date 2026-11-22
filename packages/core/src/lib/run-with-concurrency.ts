/**
 * Runs `worker` over every item in `items`, with at most `concurrency`
 * invocations in flight at once. Items are pulled from a shared cursor by a
 * fixed pool of workers, so a slow item never blocks unrelated items behind
 * it — unlike chunking `items` into fixed-size batches and awaiting each
 * batch serially.
 */
export const runWithConcurrency = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  let nextIndex = 0;

  const runPoolWorker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item, index);
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => runPoolWorker()));
};
