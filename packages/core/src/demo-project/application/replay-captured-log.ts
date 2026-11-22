import {
  logLineSchema,
  type AppendLogLineInput,
  type LogLineContract,
} from "@scarn/core/tasks/task-log/contracts/task-log-contracts";

/**
 * Pure parsing/re-anchoring helpers for replaying a REAL captured OpenCode
 * transcript (as opposed to the fabricated templates in
 * `seed-demo-execution-log-templates.ts`). Used by the demo project's
 * flagships — see `seed-demo-flagship-execution.ts` and
 * `seed-demo-coupon-double-apply-flagship.ts` — which replay four real
 * captured transcripts verbatim each. Kept free of filesystem access so both
 * functions here are trivially unit testable against in-memory
 * strings/dates.
 */

/**
 * Parses a captured task's log fixture (JSONL — one
 * `LogLineContract`-shaped JSON object per line, as originally shipped by the
 * worker) into validated log lines. Blank lines are skipped; any non-blank
 * line that fails to parse as JSON or fails `logLineSchema` validation throws
 * — a malformed fixture should fail loudly at seed time, not silently drop
 * lines from the replayed transcript.
 */
export const parseCapturedLogLines = (raw: string): LogLineContract[] =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => logLineSchema.parse(JSON.parse(line) as unknown));

/**
 * Re-anchors a captured log's timestamps onto a fresh `now`, so a replayed
 * transcript always reads as "just happened" rather than carrying its
 * original capture date. Computes each line's offset (in ms) from the FIRST
 * line's `ts`, then re-bases that same offset onto `now` — mirroring the
 * `at(offsetMs)` pattern the fabricated log templates already use. `seq`,
 * `stream`, `content`, and `level` pass through unchanged. Returns `[]` for
 * an empty input (nothing to anchor against).
 */
export const reanchorCapturedLogLines = (
  lines: readonly LogLineContract[],
  now: Date,
): AppendLogLineInput[] => {
  const firstLine = lines[0];
  if (!firstLine) {
    return [];
  }
  const firstMs = new Date(firstLine.ts).getTime();
  const nowMs = now.getTime();
  return lines.map((line) => ({
    ...line,
    ts: new Date(nowMs + (new Date(line.ts).getTime() - firstMs)).toISOString(),
  }));
};
