"use client";

import { useEffect, useState } from "react";

export const formatElapsedMs = (ms: number) => {
  if (ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${String(seconds)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(hours)}h ${String(minutes % 60)}m`;
};

export function Elapsed({
  startedAt,
  completedAt,
  endedAt,
  isRunning,
}: {
  startedAt: string | null;
  completedAt: string | null;
  endedAt?: string | null;
  isRunning: boolean;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isRunning || !startedAt) return;
    const id = setInterval(() => {
      setTick((t) => t + 1);
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [isRunning, startedAt]);

  if (!startedAt) return <>—</>;
  const end = isRunning
    ? Date.now()
    : completedAt
      ? new Date(completedAt).getTime()
      : endedAt
        ? new Date(endedAt).getTime()
        : new Date(startedAt).getTime();
  return <>{formatElapsedMs(end - new Date(startedAt).getTime())}</>;
}
