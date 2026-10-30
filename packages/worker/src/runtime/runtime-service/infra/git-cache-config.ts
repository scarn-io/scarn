import path from "node:path";
import { ConfigurationError } from "../../../lib/errors";
import { resolveHostHome } from "../domain/opencode-runtime-payload";

type Env = Record<string, string | undefined>;

export type GitCacheConfig =
  | { enabled: true; cacheDir: string }
  | { enabled: false; cacheDir: null };

/**
 * Resolves the git mirror cache configuration from environment variables.
 *
 *   - `SCARN_GIT_CACHE` is `on` or `off` (case-insensitive, trimmed). Unset or
 *     blank means `on`. Any other value is a configuration error.
 *   - `SCARN_GIT_CACHE_DIR` is an absolute directory for the mirrors. Unset or
 *     blank means `~/.scarn/git-cache` (home via `resolveHostHome`). A relative
 *     value is a configuration error.
 *
 * When the cache is `off` the result carries no directory and
 * `SCARN_GIT_CACHE_DIR` is not validated.
 */
export function resolveGitCacheConfig(env: Env): GitCacheConfig {
  if (!isCacheEnabled(env)) {
    return { enabled: false, cacheDir: null };
  }
  return { enabled: true, cacheDir: resolveCacheDir(env) };
}

function isCacheEnabled(env: Env): boolean {
  const raw = env["SCARN_GIT_CACHE"]?.trim().toLowerCase();
  if (!raw || raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  throw new ConfigurationError(
    `Unknown SCARN_GIT_CACHE value '${raw}'. Valid values are 'on' and 'off'.`,
    "GIT_CACHE_VALUE_UNKNOWN",
  );
}

function resolveCacheDir(env: Env): string {
  const configured = env["SCARN_GIT_CACHE_DIR"]?.trim();
  if (!configured) {
    return path.join(
      resolveHostHome((name) => env[name]),
      ".scarn",
      "git-cache",
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new ConfigurationError(
      `SCARN_GIT_CACHE_DIR must be an absolute path, got '${configured}'.`,
      "GIT_CACHE_DIR_NOT_ABSOLUTE",
    );
  }
  return path.resolve(configured);
}
