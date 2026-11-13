import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Env vars read from `.scarn/.env` in a local project directory. The file is
 * optional: a missing or unreadable file yields no vars.
 *
 * Shared by `work` (read on every claim, so an edited file applies to the
 * next run) and anything that has to rehearse the same environment a real
 * step would launch into — a dry run that skipped these could report a health
 * check as unhealthy when the real run, with these vars present, would pass.
 */
export async function readLocalEnvVars(
  repoDir: string,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(
      path.join(repoDir, ".scarn", ".env"),
      "utf8",
    );
    return dotenv.parse(content);
  } catch {
    return {};
  }
}
