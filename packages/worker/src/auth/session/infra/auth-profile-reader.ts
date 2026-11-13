import { statSync } from "node:fs";
import type { AuthFile, AuthProfile } from "../domain/session";
import { getAuthFilePath, loadAuthFile } from "./auth-storage";

export type AuthProfileReader = (baseUrl: string) => AuthProfile | null;

function fileStamp(filePath: string): string | null {
  try {
    const stats = statSync(filePath);
    return `${String(stats.mtimeMs)}:${String(stats.size)}:${String(stats.ino)}`;
  } catch {
    return null;
  }
}

/**
 * Reads the profile for a base URL from `auth.jsonc` on every call, so a
 * long-running worker sees a re-login or rotated token. The parsed file is
 * cached and re-read only when its mtime (or size/inode, which an atomic
 * rename changes) differs from the cached copy.
 */
export function createAuthProfileReader(): AuthProfileReader {
  let cached: { stamp: string; file: AuthFile } | null = null;
  return (baseUrl) => {
    const stamp = fileStamp(getAuthFilePath());
    if (stamp === null) {
      cached = null;
      return null;
    }
    if (cached?.stamp !== stamp) {
      cached = { stamp, file: loadAuthFile() };
    }
    return cached.file.profiles[baseUrl] ?? null;
  };
}
