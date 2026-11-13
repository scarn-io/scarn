import { readFile } from "node:fs/promises";
import { CliError } from "./cli-error";

/**
 * `--body` for the actions that send text (`comment`, `answer`, `message`):
 * the text itself, `@path` for a file's contents, or `-` for stdin.
 */

export interface BodySources {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
}

export const realBodySources: BodySources = {
  readFile: (path) => readFile(path, "utf8"),
  readStdin: () => new Response(Bun.stdin.stream()).text(),
};

async function rawBody(value: string, sources: BodySources): Promise<string> {
  if (value === "-") return sources.readStdin();
  if (!value.startsWith("@")) return value;
  const path = value.slice(1);
  try {
    return await sources.readFile(path);
  } catch (error) {
    throw new CliError(
      "body_unreadable",
      `Could not read --body file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The body text, trimmed of trailing newlines; empty is a usage error. */
export async function readBody(
  value: string,
  sources: BodySources = realBodySources,
): Promise<string> {
  const body = (await rawBody(value, sources)).replace(/\s+$/u, "");
  if (body.trim() === "") {
    throw new CliError("invalid_usage", "--body is empty.");
  }
  return body;
}
