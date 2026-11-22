"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Fraction of the viewport width a resizable panel may grow to. */
const MAX_WIDTH_VW_FRACTION = 0.9;

/**
 * The width of a right-anchored panel resized by dragging its left edge.
 * Spread `startDragging` onto the handle's `onPointerDown`; the width follows
 * the pointer, clamped between `minWidth` and 90% of the viewport, until the
 * pointer is released. `setWidth` sets it directly (e.g. a widen toggle).
 */
export function useResizableWidth({
  initialWidth,
  minWidth,
}: {
  initialWidth: number;
  minWidth: number;
}): {
  width: number;
  setWidth: (width: number) => void;
  startDragging: (event: React.PointerEvent) => void;
} {
  const [width, setRawWidth] = useState(initialWidth);
  const draggingRef = useRef(false);

  const clamp = useCallback(
    (next: number): number => {
      const max =
        typeof window === "undefined"
          ? next
          : window.innerWidth * MAX_WIDTH_VW_FRACTION;
      return Math.min(Math.max(next, minWidth), Math.max(max, minWidth));
    },
    [minWidth],
  );

  const setWidth = useCallback(
    (next: number) => {
      setRawWidth(clamp(next));
    },
    [clamp],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!draggingRef.current) return;
      setRawWidth(clamp(window.innerWidth - event.clientX));
    },
    [clamp],
  );

  const stopDragging = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [handlePointerMove, stopDragging]);

  const startDragging = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  return { width, setWidth, startDragging };
}
