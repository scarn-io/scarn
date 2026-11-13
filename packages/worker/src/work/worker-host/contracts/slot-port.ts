/**
 * Where a project loop gets its run slots from. One slot is one run in
 * flight. The loop reserves slots before claiming, hands back the ones it
 * did not use, and releases one slot when each run settles.
 *
 * The in-process {@link SlotAllocator} answers synchronously; a remote
 * implementation (borrowing slots from a running worker) answers
 * asynchronously, so the loop awaits every call.
 */
export type SlotPort = {
  /** Reserves as many slots as are free, up to `wanted`. May be 0. */
  acquire(projectId: string, wanted: number): number | Promise<number>;
  /** Hands `count` slots reserved by `projectId` back. */
  release(projectId: string, count: number): void | Promise<void>;
  /**
   * Resolves the next time slots are released or a limit changes, or when
   * `signal` aborts. Subscribe before calling {@link acquire} so a release
   * that lands in between is not missed.
   */
  changed(signal?: AbortSignal): Promise<void>;
};
