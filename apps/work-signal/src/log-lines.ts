/**
 * Log line shape and batch limits for the task-run log feed. Mirrors core's
 * `LogLineContract` / `AppendLogLineInput`
 * (`packages/core/src/tasks/task-log/contracts/task-log-contracts.ts`); this
 * Worker cannot import core, so the shape is restated here.
 *
 * Batch limits, checked against Cloudflare's docs on 2026-11-12:
 * - SQLite-backed Durable Objects: a string, BLOB or table row is capped at
 *   8 MB.
 * - WebSocket messages received by a Worker or Durable Object are capped at
 *   32 MiB.
 *
 * 512 KiB per batch keeps each stored row and each WebSocket frame far below
 * both limits. Senders (the worker's shipper) should mirror these numbers.
 */
export const LOG_STREAMS = ["worker", "ai-server", "conversation"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogStream = (typeof LOG_STREAMS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogLine {
  seq: number;
  stream: LogStream;
  ts: string;
  content: string;
  level: LogLevel;
}

export const MAX_BATCH_LINES = 1_000;
export const MAX_BATCH_BYTES = 512 * 1024;
export const MAX_READ_LINES = 2_000;

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

/** Parses JSON text into an object; `null` when it is not a JSON object. */
export function parseJsonObject(text: string): Record<string, Json> | null {
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return body;
}

/** Parses an append body `{ "lines": [...] }`; `null` when it is malformed. */
export function parseAppendBody(text: string): LogLine[] | null {
  const body = parseJsonObject(text);
  return body ? parseLogLines(body["lines"]) : null;
}

/** Validates a JSON array of log lines; `null` when any line is malformed. */
export function parseLogLines(items: Json | undefined): LogLine[] | null {
  if (!Array.isArray(items)) return null;
  const lines: LogLine[] = [];
  for (const item of items) {
    const line = parseLogLine(item);
    if (!line) return null;
    lines.push(line);
  }
  return lines;
}

function parseLogLine(value: Json): LogLine | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { seq, stream, ts, content, level } = value;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    return null;
  }
  if (!isOneOf(LOG_STREAMS, stream) || !isOneOf(LOG_LEVELS, level)) {
    return null;
  }
  if (typeof ts !== "string" || typeof content !== "string") return null;
  return { seq, stream, ts, content, level };
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: Json | undefined,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}
