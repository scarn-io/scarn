import { test } from "bun:test";
import type { TimeProvider } from "@/lib/time-provider";

type EdenResult<T> = {
  data: T | null | undefined;
  error: { value: unknown } | null | undefined;
};

export async function unwrapAsync<T>(
  promise: Promise<EdenResult<T>>,
): Promise<T> {
  const { data, error } = await promise;

  if (error) {
    throw error.value;
  }

  return data as T;
}

export async function unwrapStartedTaskAsync<T extends { run: unknown }>(
  promise: Promise<EdenResult<T>>,
): Promise<T & { run: NonNullable<T["run"]> }> {
  const created = await unwrapAsync(promise);

  if (created.run === null || created.run === undefined) {
    throw new Error("Expected the task to start with a run");
  }

  return created as T & { run: NonNullable<T["run"]> };
}

export const fixedTimeProvider = (now: Date): TimeProvider => ({
  now: () => now,
  nowIso: () => now.toISOString(),
});

export const concurrentTest =
  "concurrent" in test &&
  typeof (test as typeof test & { concurrent?: typeof test }).concurrent ===
    "function"
    ? (test as typeof test & { concurrent: typeof test }).concurrent
    : test;

export const serialTest =
  "serial" in test &&
  typeof (test as typeof test & { serial?: typeof test }).serial === "function"
    ? (test as typeof test & { serial: typeof test }).serial
    : test;
