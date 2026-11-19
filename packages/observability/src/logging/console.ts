import pino, { type Logger } from "pino";
import { REDACTED_LOG_PATHS } from "./index";

const CENSOR = "[REDACTED]";

const REDACTED_SEGMENTS = REDACTED_LOG_PATHS.map((path) => path.split("."));

// eslint-disable-next-line local/no-unknown-parameter-type -- walks arbitrary logged values.
const redactPath = (value: unknown, segments: readonly string[]): void => {
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }
  const keys = head === "*" ? Object.keys(record) : [head];
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }
    if (rest.length === 0) {
      record[key] = CENSOR;
    } else {
      redactPath(record[key], rest);
    }
  }
};

const toJsonValue = (entry: object): Record<string, unknown> =>
  JSON.parse(
    // eslint-disable-next-line local/no-unknown-parameter-type -- JSON.stringify replacer over arbitrary logged values.
    JSON.stringify(entry, (_key, value: unknown) =>
      value instanceof Error
        ? { type: value.name, message: value.message, stack: value.stack }
        : value,
    ),
  ) as Record<string, unknown>;

/**
 * Serializes `entry` to one JSON line with every `REDACTED_LOG_PATHS` match
 * censored, matching what `createLogger` writes.
 */
export const formatLogLine = (entry: object): string => {
  const value = toJsonValue(entry);
  for (const segments of REDACTED_SEGMENTS) {
    redactPath(value, segments);
  }
  return JSON.stringify(value);
};

/**
 * A pino-compatible logger that writes one JSON line per entry to `console`,
 * for Cloudflare Workers, which have no stdout stream (the Worker bundle
 * resolves `pino` to its browser build, which honours `browser.write`).
 */
export function createConsoleLogger(options: ConsoleLoggerOptions): Logger {
  return createConsoleLoggerWith(pino, options);
}

type ConsoleLoggerOptions = { name: string; level?: string };

/** `createConsoleLogger` with the `pino` build injected, for tests under Bun. */
export function createConsoleLoggerWith(
  pinoImpl: typeof pino,
  options: ConsoleLoggerOptions,
): Logger {
  return pinoImpl({
    name: options.name,
    level: options.level ?? "info",
    browser: {
      asObject: true,
      write: (entry: object) => {
        const line = formatLogLine({ name: options.name, ...entry });
        const level = (entry as { level?: number }).level ?? 30;
        if (level >= 50) console.error(line);
        else if (level >= 40) console.warn(line);
        // eslint-disable-next-line no-console -- console is the Worker's log sink.
        else console.log(line);
      },
    },
  });
}
