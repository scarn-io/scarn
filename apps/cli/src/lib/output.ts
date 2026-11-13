import type { Argv } from "yargs";

/**
 * The stdout contract shared by every read command: text by default, one
 * pretty-printed JSON document with `--json`, and nothing else on stdout
 * either way. Human status and errors go to stderr through `withReporter`.
 */

export interface OutputArguments {
  json: boolean;
  limit: number | undefined;
}

/** Prints `value` as a single pretty-printed JSON document. */
// eslint-disable-next-line local/no-unknown-parameter-type -- serialization boundary: any API body or gathered structure
export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Prints text lines, one per line. */
export function writeText(lines: string | readonly string[]): void {
  const text = typeof lines === "string" ? lines : lines.join("\n");
  process.stdout.write(`${text}\n`);
}

/** The trailing suggestion a listing ends with, e.g.
 * `→ scarn runs list`. */
export function nextHint(command: string): string {
  return `→ ${command}`;
}

/** Adds `--json` and `--limit` to a read command. `--base-url` comes from
 * `withProjectOptions` or `withBaseUrlOption` (`./connect-project`). */
export const withOutputOptions = <T>(argv: Argv<T>) =>
  argv
    .option("json", {
      type: "boolean",
      default: false,
      describe: "Print the result as a single JSON document",
    })
    .option("limit", {
      type: "number",
      describe: "Maximum number of entries to show",
    });
