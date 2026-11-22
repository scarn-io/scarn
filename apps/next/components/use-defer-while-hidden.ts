"use client";

import { useCallback, useEffect, useRef } from "react";

export function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/** Resolves once the tab is visible (immediately if it already is), or when `signal` aborts. */
export function waitUntilVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted || !isPageHidden()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const onVisibilityChange = () => {
      if (!isPageHidden()) finish();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal.addEventListener("abort", finish);
  });
}

/**
 * Lets a poller skip work while the tab is hidden and catch up once it is
 * visible again.
 *
 * The returned `deferIfHidden` answers whether the page is hidden right now;
 * when it is, it also marks a refresh as owed. Once the tab becomes visible
 * with a refresh owed, `onVisible` runs once. `onVisible` should be stable.
 */
export function useDeferWhileHidden(
  onVisible: () => void,
  enabled: boolean = true,
): () => boolean {
  const refreshOwed = useRef(false);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (isPageHidden() || !refreshOwed.current) return;
      refreshOwed.current = false;
      onVisible();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, onVisible]);

  return useCallback(() => {
    refreshOwed.current = isPageHidden();
    return refreshOwed.current;
  }, []);
}
