import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { getAuthFilePath } from "@scarn/sdk/defaults";

/** Calls `onChange` whenever the auth file changes; returns an unsubscribe. */
export type AuthFileWatcher = (onChange: () => void) => () => void;

/**
 * Watches the directory holding `auth.jsonc` rather than the file itself:
 * logins replace the file atomically (a new inode), and the file may not
 * exist yet. When the directory cannot be watched it never fires, and the
 * caller's retry timer is the fallback.
 */
export const watchAuthFile: AuthFileWatcher = (onChange) => {
  const authFilePath = getAuthFilePath();
  const fileName = basename(authFilePath);
  try {
    const watcher = watch(dirname(authFilePath), (_event, changed) => {
      if (changed === null || changed === fileName) onChange();
    });
    watcher.on("error", () => {
      watcher.close();
    });
    return () => {
      watcher.close();
    };
  } catch {
    return () => {};
  }
};
