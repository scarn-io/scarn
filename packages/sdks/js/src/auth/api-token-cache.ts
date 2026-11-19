import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { writeJsonFileAtomically } from "../defaults/atomic-json-file";
import { resolveHomeDir } from "../defaults/home-dir";

/**
 * On-disk cache of short-lived API tokens (`~/.scarn/api-tokens.jsonc`),
 * keyed by base URL exactly as `auth.jsonc` keys its profiles. Each entry
 * remembers a hash of the session token it was minted from, so a re-login
 * makes it stale. Kept apart from `auth.jsonc` because the worker watches that
 * file for re-logins and token refreshes must not trigger it.
 */
export interface ApiTokenCacheEntry {
  sessionHash: string;
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface ApiTokenCacheFile {
  tokens: Record<string, ApiTokenCacheEntry>;
}

const apiTokenCacheFilePath = () =>
  join(resolveHomeDir(), ".scarn", "api-tokens.jsonc");

export const getApiTokenCacheFilePath = () => apiTokenCacheFilePath();

// eslint-disable-next-line local/no-unknown-parameter-type
function isApiTokenCacheEntry(value: unknown): value is ApiTokenCacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["sessionHash"] === "string" &&
    typeof obj["token"] === "string" &&
    typeof obj["expiresAt"] === "number"
  );
}

const readCacheFile = (): ApiTokenCacheFile => {
  const tokens: Record<string, ApiTokenCacheEntry> = {};
  try {
    const filePath = apiTokenCacheFilePath();
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
      return { tokens };
    }
    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(readFileSync(filePath, "utf8"), errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0 || typeof parsed !== "object" || parsed === null) {
      return { tokens };
    }
    const rawTokens = (parsed as Record<string, unknown>)["tokens"];
    if (typeof rawTokens !== "object" || rawTokens === null) return { tokens };
    for (const [baseUrl, entry] of Object.entries(rawTokens)) {
      if (isApiTokenCacheEntry(entry)) tokens[baseUrl] = entry;
    }
  } catch {
    return { tokens: {} };
  }
  return { tokens };
};

export const loadApiTokenCacheEntry = (
  baseUrl: string,
): ApiTokenCacheEntry | null => readCacheFile().tokens[baseUrl] ?? null;

export const saveApiTokenCacheEntry = (
  baseUrl: string,
  entry: ApiTokenCacheEntry,
) => {
  const file = readCacheFile();
  file.tokens[baseUrl] = entry;
  writeJsonFileAtomically(apiTokenCacheFilePath(), file);
};

/**
 * Removes the cached token for `baseUrl`. With `onlyToken`, the entry is
 * removed only if it still holds that token, so a token another process has
 * just refreshed is left alone.
 */
export const deleteApiTokenCacheEntry = (
  baseUrl: string,
  options?: { onlyToken?: string },
) => {
  const file = readCacheFile();
  const entry = file.tokens[baseUrl];
  if (!entry) return;
  if (options?.onlyToken !== undefined && entry.token !== options.onlyToken) {
    return;
  }
  writeJsonFileAtomically(apiTokenCacheFilePath(), {
    tokens: Object.fromEntries(
      Object.entries(file.tokens).filter(([key]) => key !== baseUrl),
    ),
  });
};
