/**
 * The OS signals that stop a foreground worker: SIGINT and SIGTERM, or only
 * SIGINT on Windows, where SIGTERM cannot be caught.
 */
export type SubscribeStopSignals = (
  onSignal: (signal: string) => void,
) => () => void;

export function stopSignalsFor(
  platform: NodeJS.Platform = process.platform,
): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
}

/** Listens for the stop signals until the returned function is called. */
export function subscribeProcessStopSignals(
  onSignal: (signal: string) => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  const signals = stopSignalsFor(platform);
  const listener = (signal: NodeJS.Signals) => {
    onSignal(signal);
  };
  for (const signal of signals) process.on(signal, listener);
  return () => {
    for (const signal of signals) process.off(signal, listener);
  };
}
