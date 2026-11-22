/**
 * On the Free plan, a Durable Object that never hibernates is the realistic
 * way to exhaust the daily duration allowance. This guard fails on any API in
 * the Durable Object sources that would keep the object awake.
 *
 * `TaskRunLogFeed` may call `setAlarm`, but only in `append` (abandonment)
 * and `seal` (deletion after archiving): one alarm per lifecycle event.
 */
import { describe, expect, it } from "vitest";
import projectWorkSignalSource from "../src/project-work-signal.ts?raw";
import taskRunLogFeedSource from "../src/task-run-log-feed.ts?raw";

/** `fetch(` ignores the object's own `override fetch(request)` handler. */
const ALWAYS_FORBIDDEN: [label: string, pattern: RegExp][] = [
  ["setTimeout", /\bsetTimeout\b/],
  ["setInterval", /\bsetInterval\b/],
  [".accept(", /\.accept\(/],
  ["fetch(", /(?<!override\s+)\bfetch\(/],
  ["new WebSocket(", /new\s+WebSocket\(/],
];
const SET_ALARM: [label: string, pattern: RegExp] = [
  "setAlarm(",
  /\bsetAlarm\(/,
];

const SET_ALARM_ALLOWED_IN = ["append", "seal"];

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Method name → body, for class methods declared at two-space indentation. */
function methodBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const methodStart =
    /^ {2}(?:(?:private|override|async|static)\s+)*(\w+)\s*\([^)]*\)[^{\n]*\{$/gm;
  const starts = [...source.matchAll(methodStart)];
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1]?.index ?? source.length;
    bodies.set(start[1] ?? "", source.slice(start.index, end));
  }
  return bodies;
}

const SOURCES: [file: string, source: string][] = [
  ["src/project-work-signal.ts", codeOnly(projectWorkSignalSource)],
  ["src/task-run-log-feed.ts", codeOnly(taskRunLogFeedSource)],
];

function failureMessage(file: string, label: string): string {
  return (
    `${file} uses "${label}", which blocks hibernation. ` +
    "See docs/research/worker-wakeup/cloudflare-durable-objects.md §5 (Risks and gotchas)."
  );
}

describe.each(SOURCES)("%s hibernation guard", (file, source) => {
  it.each(ALWAYS_FORBIDDEN)("does not use %s", (label, pattern) => {
    expect(pattern.test(source), failureMessage(file, label)).toBe(false);
  });
});

describe("setAlarm", () => {
  it("is never used by ProjectWorkSignal", () => {
    const [label, pattern] = SET_ALARM;
    expect(
      pattern.test(codeOnly(projectWorkSignalSource)),
      failureMessage("src/project-work-signal.ts", label),
    ).toBe(false);
  });

  it("is used by TaskRunLogFeed only in append and seal", () => {
    const callers = [...methodBodies(codeOnly(taskRunLogFeedSource))]
      .filter(([, body]) => SET_ALARM[1].test(body))
      .map(([name]) => name)
      .sort();
    expect(callers).toEqual(SET_ALARM_ALLOWED_IN);
  });
});
