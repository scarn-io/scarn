"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { INBOX_CHANGED_EVENT } from "@/components/inbox/inbox-api";
import { useDeferWhileHidden } from "@/components/use-defer-while-hidden";

/**
 * Re-runs `load` now, every `pollIntervalMs`, and whenever an inbox action
 * fires {@link INBOX_CHANGED_EVENT}. Skips everything while `enabled` is false.
 * A new `load` identity (e.g. a changed query) loads again at once.
 *
 * While the tab is hidden nothing loads: a due poll, a mount, or an inbox
 * change only marks a refresh as owed, which runs once the tab is visible
 * again and restarts the polling cycle.
 */
export function usePolledLoad(
  load: (isCancelled: () => boolean) => Promise<void>,
  enabled: boolean,
  pollIntervalMs: number,
): () => void {
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);
  const deferIfHidden = useDeferWhileHidden(refresh, enabled);

  useEffect(() => {
    if (!enabled || deferIfHidden()) return;
    let cancelled = false;
    void load(() => cancelled).finally(() => {
      if (cancelled) return;
      timer.current = setTimeout(() => {
        if (!deferIfHidden()) refresh();
      }, pollIntervalMs);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, [load, enabled, pollIntervalMs, nonce, deferIfHidden, refresh]);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener(INBOX_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(INBOX_CHANGED_EVENT, refresh);
    };
  }, [enabled, refresh]);

  return refresh;
}
