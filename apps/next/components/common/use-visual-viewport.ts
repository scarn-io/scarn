"use client";

import { useEffect, useState } from "react";

/**
 * The height and offset of the visible viewport, so a fixed full-screen
 * panel shrinks above the on-screen keyboard (iOS Safari doesn't resize
 * `dvh` for it). Falls back to `100dvh` before hydration or without
 * `window.visualViewport`.
 */
export function useVisualViewport(): { height: string; top: number } {
  const [viewport, setViewport] = useState<{ height: string; top: number }>({
    height: "100dvh",
    top: 0,
  });
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () => {
      setViewport({
        height: `${String(visual.height)}px`,
        top: visual.offsetTop,
      });
    };
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);
  return viewport;
}
