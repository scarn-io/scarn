"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Distance (px) from the bottom within which the container counts as pinned. */
export const FOLLOW_PIN_THRESHOLD_PX = 80;

function isPinned(el: HTMLElement): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PIN_THRESHOLD_PX
  );
}

function scrollToBottom(el: HTMLElement) {
  el.scrollTop = el.scrollHeight;
}

/**
 * Terminal-style follow for a scroll container. While the container is pinned
 * to its bottom, new content (a change in `contentCount`) scrolls it back to
 * the bottom; scrolling up stops following, and `unseen` counts the content
 * that has arrived since. `jumpToLatest` scrolls down and resets the count.
 *
 * `contentCount` is a count of content units (e.g. log lines) so the unseen
 * delta is meaningful. Follow is decided by the scroll gesture alone and kept
 * on a ref, so reaching the bottom never re-triggers a programmatic scroll.
 */
export function useFollowScroll(
  ref: RefObject<HTMLElement | null>,
  contentCount: number,
  { initiallyPinned = true }: { initiallyPinned?: boolean } = {},
): { unseen: number; jumpToLatest: () => void } {
  const pinnedRef = useRef(initiallyPinned);
  const seenCountRef = useRef(contentCount);
  const contentCountRef = useRef(contentCount);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const pinned = isPinned(el);
      pinnedRef.current = pinned;
      if (pinned) {
        seenCountRef.current = contentCountRef.current;
        setUnseen(0);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref]);

  useEffect(() => {
    contentCountRef.current = contentCount;
    if (pinnedRef.current) {
      const el = ref.current;
      if (el) scrollToBottom(el);
      seenCountRef.current = contentCount;
      setUnseen(0);
    } else {
      setUnseen(Math.max(0, contentCount - seenCountRef.current));
    }
  }, [ref, contentCount]);

  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (el) scrollToBottom(el);
    pinnedRef.current = true;
    seenCountRef.current = contentCountRef.current;
    setUnseen(0);
  }, [ref]);

  return { unseen, jumpToLatest };
}
