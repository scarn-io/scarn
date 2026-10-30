import { describe, expect, test } from "bun:test";
import {
  SCARN_CLI_FALLBACK_COMMAND,
  isCompiledStandaloneEntry,
  resolveScarnCliPath,
} from "../src/lib/resolve-cli-path";

/**
 * `$SCARN_CLI` is what the designer agent shells out to in order to push, so
 * getting it wrong turns the last step of the session into a dead end. The two
 * shapes the CLI actually runs in resolve very differently — see the module
 * docblock — so both are pinned here.
 */

const COMPILED_BINARY = "/Users/x/.bun/install/global/dist/scarn-darwin-arm64";
const COMPILED_ENTRY = "/$bunfs/root/scarn-darwin-arm64";
const DEV_BUN = "/opt/homebrew/bin/bun";
const DEV_ENTRY = "/repo/apps/cli/src/index.ts";
const DEV_WRAPPER = "/repo/apps/cli/bin/scarn";

describe("isCompiledStandaloneEntry", () => {
  test.each([
    ["/$bunfs/root/scarn-darwin-arm64", true],
    ["B:\\~BUN\\root\\scarn-windows-x64.exe", true],
    ["/repo/apps/cli/src/index.ts", false],
    ["", false],
  ])("%s → %s", (entry, expected) => {
    expect(isCompiledStandaloneEntry(entry)).toBe(expected);
  });

  test("undefined entry is not a compiled entry", () => {
    expect(isCompiledStandaloneEntry(undefined)).toBe(false);
  });
});

describe("resolveScarnCliPath", () => {
  test("compiled binary resolves to process.execPath", () => {
    // In a `bun build --compile` binary the entry lives in bun's embedded
    // virtual FS, and execPath is the binary itself — directly executable.
    expect(
      resolveScarnCliPath({
        execPath: COMPILED_BINARY,
        entryPath: COMPILED_ENTRY,
        fileExists: () => false,
      }),
    ).toBe(COMPILED_BINARY);
  });

  test("dev run resolves to the bin wrapper, never to the bun binary", () => {
    // execPath here is bun, which would run the wrong program entirely.
    expect(
      resolveScarnCliPath({
        execPath: DEV_BUN,
        entryPath: DEV_ENTRY,
        fileExists: (path) => path === DEV_WRAPPER,
      }),
    ).toBe(DEV_WRAPPER);
  });

  test("dev run without a built wrapper falls back to the bare command", () => {
    expect(
      resolveScarnCliPath({
        execPath: DEV_BUN,
        entryPath: DEV_ENTRY,
        fileExists: () => false,
      }),
    ).toBe(SCARN_CLI_FALLBACK_COMMAND);
  });

  test("an explicit SCARN_CLI override wins over both", () => {
    expect(
      resolveScarnCliPath({
        execPath: COMPILED_BINARY,
        entryPath: COMPILED_ENTRY,
        envOverride: "/custom/scarn",
        fileExists: () => true,
      }),
    ).toBe("/custom/scarn");
  });

  test("a blank override is ignored", () => {
    expect(
      resolveScarnCliPath({
        execPath: COMPILED_BINARY,
        entryPath: COMPILED_ENTRY,
        envOverride: "   ",
        fileExists: () => false,
      }),
    ).toBe(COMPILED_BINARY);
  });

  test("a missing entry path falls back to the bare command", () => {
    expect(
      resolveScarnCliPath({
        execPath: DEV_BUN,
        entryPath: undefined,
        fileExists: () => true,
      }),
    ).toBe(SCARN_CLI_FALLBACK_COMMAND);
  });
});
