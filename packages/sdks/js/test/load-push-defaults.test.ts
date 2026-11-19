import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHomeDirForTests } from "../src/defaults/home-dir";
import { loadPushDefaults } from "../src/defaults/load-push-defaults";

const API_TOKEN = [
  "header",
  Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url"),
  "signature",
].join(".");

describe("loadPushDefaults", () => {
  const savedEnv = {
    SCARN_BASE_URL: process.env["SCARN_BASE_URL"],
    SCARN_PROJECT_ID: process.env["SCARN_PROJECT_ID"],
    SCARN_ACCESS_TOKEN: process.env["SCARN_ACCESS_TOKEN"],
  };

  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "scarn-defaults-home-"));
    setHomeDirForTests(home);
    delete process.env["SCARN_BASE_URL"];
    delete process.env["SCARN_PROJECT_ID"];
    delete process.env["SCARN_ACCESS_TOKEN"];
  });

  afterEach(() => {
    setHomeDirForTests(undefined);
    rmSync(home, { recursive: true, force: true });
    if (savedEnv.SCARN_BASE_URL === undefined) {
      delete process.env["SCARN_BASE_URL"];
    } else {
      process.env["SCARN_BASE_URL"] = savedEnv.SCARN_BASE_URL;
    }
    if (savedEnv.SCARN_PROJECT_ID === undefined) {
      delete process.env["SCARN_PROJECT_ID"];
    } else {
      process.env["SCARN_PROJECT_ID"] = savedEnv.SCARN_PROJECT_ID;
    }
    if (savedEnv.SCARN_ACCESS_TOKEN === undefined) {
      delete process.env["SCARN_ACCESS_TOKEN"];
    } else {
      process.env["SCARN_ACCESS_TOKEN"] = savedEnv.SCARN_ACCESS_TOKEN;
    }
  });

  test("env vars take precedence over discovered values", async () => {
    process.env["SCARN_BASE_URL"] = "https://override.example.com";
    process.env["SCARN_PROJECT_ID"] = "env-proj";
    process.env["SCARN_ACCESS_TOKEN"] = "env-token";

    const dir = mkdtempSync(join(tmpdir(), "scarn-defaults-env-"));
    try {
      const result = await loadPushDefaults({ dir });
      expect(result.baseUrl).toBe("https://override.example.com");
      expect(result.projectId).toBe("env-proj");
      expect(result.fetch).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("walks ancestor dirs to find .scarn/scarn.jsonc when env is unset", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "scarn-defaults-walk-"));
    const childDir = join(rootDir, "deeply", "nested");
    mkdirSync(childDir, { recursive: true });

    mkdirSync(join(rootDir, ".scarn"), { recursive: true });
    writeFileSync(
      join(rootDir, ".scarn", "scarn.jsonc"),
      JSON.stringify({ project: "acme/web-app" }),
    );
    process.env["SCARN_BASE_URL"] = "https://scarn.example.com";
    process.env["SCARN_ACCESS_TOKEN"] = "env-token";

    const requested: Array<[string, string | null]> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requested.push([request.url, request.headers.get("Authorization")]);
      return Promise.resolve(
        Response.json(
          request.url.endsWith("/api/auth/token")
            ? { token: API_TOKEN }
            : { id: "walked-proj" },
        ),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await loadPushDefaults({ dir: childDir });
      expect(result.projectId).toBe("walked-proj");
      expect(requested).toEqual([
        ["https://scarn.example.com/api/auth/token", "Bearer env-token"],
        [
          "https://scarn.example.com/api/projects/resolve?username=acme&slug=web-app",
          `Bearer ${API_TOKEN}`,
        ],
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("names the ref and the action when the server forbids the configured project", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "scarn-defaults-forbidden-"));
    mkdirSync(join(rootDir, ".scarn"), { recursive: true });
    writeFileSync(
      join(rootDir, ".scarn", "scarn.jsonc"),
      JSON.stringify({ project: "acme/web-app" }),
    );
    process.env["SCARN_ACCESS_TOKEN"] = "env-token";

    const previousFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input);
      return Promise.resolve(
        request.url.endsWith("/api/auth/token")
          ? Response.json({ token: API_TOKEN })
          : Response.json(
              { type: "x", title: "Forbidden", status: 403 },
              { status: 403 },
            ),
      );
    }) as unknown as typeof globalThis.fetch;

    try {
      let message = "";
      try {
        await loadPushDefaults({ dir: rootDir });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(
        "You don't have permission to push pipelines to acme/web-app.",
      );
    } finally {
      globalThis.fetch = previousFetch;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("returns undefined projectId when no config is found and no env is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scarn-defaults-empty-"));
    try {
      const result = await loadPushDefaults({ dir });
      expect(result.projectId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
