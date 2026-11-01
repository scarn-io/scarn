import { useSyncExternalStore } from "react";
import type { UseSuccessMessage } from "./template-detail-model";

/**
 * Carries the "template used" toast from the detail page, which navigates
 * away on success, to the pipelines screen that shows it. A module-level
 * store rather than history state: the router's `replaceState` always
 * passes `null`, and the toast shouldn't come back on a reload.
 */
let current: UseSuccessMessage | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function showUseToast(message: UseSuccessMessage): void {
  current = message;
  emit();
}

export function dismissUseToast(): void {
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UseSuccessMessage | null {
  return current;
}

export function useUseToast(): UseSuccessMessage | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
