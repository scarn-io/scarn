import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  deleteApiTokenCacheEntry,
  getApiTokenCacheFilePath,
  loadApiTokenCacheEntry,
  saveApiTokenCacheEntry,
} from "../src/auth/api-token-cache";
import { setHomeDirForTests } from "../src/defaults/home-dir";

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "scarn-api-token-cache-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

const entry = { sessionHash: "h1", token: "jwt-1", expiresAt: 123 };

describe("api token cache", () => {
  test("round-trips an entry per base URL at ~/.scarn/api-tokens.jsonc", () => {
    saveApiTokenCacheEntry("https://a.test", entry);
    saveApiTokenCacheEntry("https://b.test", { ...entry, token: "jwt-2" });

    expect(getApiTokenCacheFilePath()).toBe(
      join(fakeHome, ".scarn", "api-tokens.jsonc"),
    );
    expect(loadApiTokenCacheEntry("https://a.test")).toEqual(entry);
    expect(loadApiTokenCacheEntry("https://b.test")?.token).toBe("jwt-2");
  });

  test("writes the file with mode 0600", () => {
    saveApiTokenCacheEntry("https://a.test", entry);
    expect(statSync(getApiTokenCacheFilePath()).mode & 0o777).toBe(0o600);
  });

  test("treats a corrupt file as empty", () => {
    const filePath = getApiTokenCacheFilePath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json");

    expect(loadApiTokenCacheEntry("https://a.test")).toBeNull();
    saveApiTokenCacheEntry("https://a.test", entry);
    expect(loadApiTokenCacheEntry("https://a.test")).toEqual(entry);
  });

  test("ignores malformed entries", () => {
    const filePath = getApiTokenCacheFilePath();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ tokens: { "https://a.test": { token: 1 } } }),
    );
    expect(loadApiTokenCacheEntry("https://a.test")).toBeNull();
  });

  test("deletes an entry, or only when it still holds the given token", () => {
    saveApiTokenCacheEntry("https://a.test", entry);
    saveApiTokenCacheEntry("https://b.test", entry);

    deleteApiTokenCacheEntry("https://a.test", { onlyToken: "other" });
    expect(loadApiTokenCacheEntry("https://a.test")).toEqual(entry);

    deleteApiTokenCacheEntry("https://a.test", { onlyToken: "jwt-1" });
    expect(loadApiTokenCacheEntry("https://a.test")).toBeNull();

    deleteApiTokenCacheEntry("https://b.test");
    expect(loadApiTokenCacheEntry("https://b.test")).toBeNull();
  });
});
