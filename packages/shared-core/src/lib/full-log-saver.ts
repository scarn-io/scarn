import type { TaskLogStream } from "./api-types";

/**
 * Saves a task run's full, uncapped rendered log to some caller-owned
 * location (the `shared-core` package stays side-effect-free; only
 * `apps/cli` supplies a real, disk-touching implementation). Resolves to the
 * path written, which goes on the log header line; a rejection's message is
 * shown there instead.
 */
export type FullLogSaver = (input: {
  taskRunId: string;
  requestedStream: TaskLogStream | "all";
  fullText: string;
}) => Promise<string>;
