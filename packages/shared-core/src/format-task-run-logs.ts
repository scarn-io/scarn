import {
  capLogBody,
  MAX_LOG_RENDER_CHARS,
  renderLogText,
  withFullLogLocation,
} from "./format-logs";
import type { GatheredTaskRunLogs } from "./gather-task-run-logs";
import { looseStatusGlyph } from "./lib/status-glyphs";

/**
 * Text and JSON rendering for `scarn logs`. Line numbers always refer to the
 * full rendered log, which is the file the CLI saves, so an agent can open
 * that file at a line it saw here.
 */

/** The full, uncapped log of a Task run, as saved to disk. */
export function renderTaskRunLogText(gathered: GatheredTaskRunLogs): string {
  return renderLogText({
    subject: `Task run ${gathered.run.id}`,
    lines: gathered.lines,
    requestedStream: gathered.requestedStream,
    source: gathered.source,
  });
}

export type LogLineSelection = {
  /** Keep only lines matching this pattern. */
  grep?: RegExp;
  /** Keep only the last N lines (after `sinceLine` and `grep`). */
  tail?: number;
  /** Keep only lines after this 1-based line number. */
  sinceLine?: number;
};

export type NumberedLogLine = { line: number; text: string };

export function hasSelection(selection: LogLineSelection): boolean {
  return (
    selection.grep !== undefined ||
    selection.tail !== undefined ||
    selection.sinceLine !== undefined
  );
}

/** Applies `--since-line`, then `--grep`, then `--tail` to the full text. */
export function selectLogLines(
  fullText: string,
  selection: LogLineSelection,
): NumberedLogLine[] {
  let numbered = fullText
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }));
  const { grep, tail, sinceLine } = selection;
  if (sinceLine !== undefined) {
    numbered = numbered.filter((entry) => entry.line > sinceLine);
  }
  if (grep !== undefined) {
    numbered = numbered.filter((entry) => grep.test(entry.text));
  }
  if (tail !== undefined) {
    numbered = tail <= 0 ? [] : numbered.slice(-tail);
  }
  return numbered;
}

/** Where the full log went: a path, or why it was not saved. */
export type SavedLog = { path: string } | { error: string };

function savedLocation(saved: SavedLog): string {
  return "path" in saved ? saved.path : `not saved (${saved.error})`;
}

function runLine(gathered: GatheredTaskRunLogs): string {
  const { run } = gathered;
  return `Task run ${run.id}  ${looseStatusGlyph(run.status)} ${run.status}  Task ${run.taskId}  run #${String(run.number)}`;
}

function describeSelection(selection: LogLineSelection): string {
  const parts: string[] = [];
  if (selection.sinceLine !== undefined) {
    parts.push(`after line ${String(selection.sinceLine)}`);
  }
  if (selection.grep !== undefined) {
    parts.push(`matching ${String(selection.grep)}`);
  }
  if (selection.tail !== undefined) {
    parts.push(`last ${String(selection.tail)}`);
  }
  return parts.join(", ");
}

function renderSelected(
  fullText: string,
  selection: LogLineSelection,
): string[] {
  const selected = selectLogLines(fullText, selection);
  const totalLines = fullText.split("\n").length;
  const width = String(totalLines).length;
  const header = `${String(selected.length)} of ${String(totalLines)} lines (${describeSelection(selection)}):`;
  if (selected.length === 0) return [header, "(no lines)"];
  const body = selected
    .map((entry) => `${String(entry.line).padStart(width)}  ${entry.text}`)
    .join("\n");
  return [capLogBody(`${header}\n\n${body}`, MAX_LOG_RENDER_CHARS)];
}

/** The hints `scarn logs` ends with. */
export function taskRunLogHints(taskRunId: string): string[] {
  return [
    `→ scarn artifacts list ${taskRunId}`,
    `→ scarn task-runs view ${taskRunId}`,
  ];
}

export type FormatTaskRunLogsInput = {
  gathered: GatheredTaskRunLogs;
  fullText: string;
  saved: SavedLog;
  selection: LogLineSelection;
  /** Omit the trailing hints, e.g. while `--follow` keeps printing. */
  withHints?: boolean;
};

/**
 * Without a selection: the log capped to {@link MAX_LOG_RENDER_CHARS},
 * keeping the tail. With `--grep`, `--tail` or `--since-line`: the
 * selected lines with their line numbers in the saved file.
 */
export function formatTaskRunLogs(input: FormatTaskRunLogsInput): string {
  const { gathered, fullText, saved, selection } = input;
  const location = savedLocation(saved);
  const lines = [runLine(gathered), ""];
  if (hasSelection(selection)) {
    lines.push(
      `Full log: ${location}`,
      "",
      ...renderSelected(fullText, selection),
    );
  } else {
    lines.push(
      capLogBody(withFullLogLocation(fullText, location), MAX_LOG_RENDER_CHARS),
    );
  }
  if (input.withHints !== false) {
    lines.push("", ...taskRunLogHints(gathered.run.id));
  }
  return lines.join("\n");
}

/** `scarn logs --json`: one document with the selected, numbered lines. */
export function taskRunLogsJson(input: FormatTaskRunLogsInput) {
  const { gathered, fullText, saved, selection } = input;
  return {
    taskRunId: gathered.run.id,
    taskId: gathered.run.taskId,
    runNumber: gathered.run.number,
    status: gathered.run.status,
    source: gathered.source,
    stream: gathered.requestedStream,
    savedTo: "path" in saved ? saved.path : null,
    saveError: "error" in saved ? saved.error : null,
    totalLines: fullText.split("\n").length,
    lines: selectLogLines(fullText, selection),
  };
}
