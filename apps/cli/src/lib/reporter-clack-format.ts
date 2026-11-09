import pc from "picocolors";
import { formatElapsed, shortId } from "./reporter-types";

/**
 * Pure string formatting for `ClackReporter`: task spinner labels, the
 * devcontainer rolling-log lines, and task failure reasons.
 */

/**
 * How many recent devcontainer log lines to keep visible under the title.
 * Enough to show a meaningful tail of the lifecycle without flooding the
 * terminal. On failure, these retained lines are the primary diagnostic hint
 * shown to the user (the raw output is in the pino log file).
 */
export const DEVCONTAINER_LOG_WINDOW = 12;

/**
 * Max width (chars) for a single devcontainer log line in the rolling window.
 * Lines longer than this are truncated with an ellipsis so the window doesn't
 * wrap and blow up the height of the live region.
 */
const DEVCONTAINER_LINE_MAX_WIDTH = 100;

/**
 * Max length for the task failure reason shown inline beneath the spinner.
 * With the raw devcontainer CLI output stripped upstream this is now a clean
 * single-sentence message, so 500 chars is a generous safety net.
 */
const TASK_REASON_MAX_LENGTH = 500;

/**
 * Build the spinner message label for a task. When `elapsedMs` is provided it
 * is appended so a parked line captures the final duration at park time.
 */
export const formatTaskLabel = (
  taskRunId: string,
  phase: string,
  elapsedMs?: number,
): string => {
  const elapsed =
    elapsedMs !== undefined ? pc.dim(` · ${formatElapsed(elapsedMs)}`) : "";
  return `task ${pc.cyan(shortId(taskRunId))} ${pc.dim(phase)}${elapsed}`;
};

/** Truncate a task failure reason to a safe inline length. */
export const formatTaskReason = (reason: string): string =>
  reason.length > TASK_REASON_MAX_LENGTH
    ? `${reason.slice(0, TASK_REASON_MAX_LENGTH)}…`
    : reason;

/**
 * Format one devcontainer progress line for the taskLog body: truncated so it
 * can't wrap, colorized by severity first (errors/warnings stand out), then by
 * milestone/detail emphasis.
 */
export const formatDevcontainerLine = (
  kind: "milestone" | "detail",
  phase: string,
  level: "info" | "warn" | "error",
): string => {
  const displayPhase =
    phase.length > DEVCONTAINER_LINE_MAX_WIDTH
      ? `${phase.slice(0, DEVCONTAINER_LINE_MAX_WIDTH - 1)}…`
      : phase;
  if (level === "error") return pc.red(displayPhase);
  if (level === "warn") return pc.yellow(displayPhase);
  return kind === "milestone" ? pc.cyan(displayPhase) : pc.dim(displayPhase);
};
