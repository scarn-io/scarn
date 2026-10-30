/**
 * Side-effect-only bootstrap. MUST be imported before anything that pulls in
 * `@scarn/worker`, because the worker constructs module-level pino loggers at
 * import time, each defaulting to `SCARN_LOG_LEVEL ?? "info"`.
 *
 * On an interactive TTY the reporter is the user-facing surface. We previously
 * pinned SCARN_LOG_LEVEL to "silent" here to keep logs off the terminal, but
 * that also suppressed the file log (pino filters at the logger level, before
 * any per-stream level in multistream). Silencing is now done per-stream inside
 * createTransport(): the pretty-stderr stream is set to "silent" unless
 * --verbose, while the file stream always runs at "trace".
 *
 * We still ensure a floor of "trace" on TTY so the logger doesn't accidentally
 * filter before multistream sees the record. An explicit SCARN_LOG_LEVEL
 * overrides this (e.g. for tests or CI that want a specific level).
 *
 * This module deliberately has NO imports so its side effect runs as early as
 * possible in the module graph.
 */

if (!process.env["SCARN_LOG_LEVEL"] && process.stdout.isTTY) {
  // Always log at trace so the file sink (set up in createTransport) receives
  // every record. The pretty-stderr stream is silenced per-stream when not in
  // verbose mode, so the terminal stays clean without losing file output.
  process.env["SCARN_LOG_LEVEL"] = "trace";
}

export {};
