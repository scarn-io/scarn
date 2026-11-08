/**
 * Unit tests for {@link buildGitCredentialHelperScript}: a snapshot of the
 * generated `git-credential-scarn` plus the properties that must not drift.
 */
import { describe, expect, test } from "bun:test";
import { buildGitCredentialHelperScript } from "../../../../src/runtime/git-credentials/domain/git-credential-helper-script";

describe("git credential helper script", () => {
  const script = buildGitCredentialHelperScript();

  test("matches the snapshot", () => {
    expect(script).toMatchSnapshot();
  });

  test("is POSIX sh that always exits 0", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
    expect(script).not.toContain("set -e");
  });

  test("posts with curl, falling back to wget, and explains when neither exists", () => {
    expect(script).toContain("curl -fsS --max-time 15");
    expect(script).toContain("wget -qO-");
    expect(script).toContain(
      "scarn: git credential helper needs curl or wget in the container",
    );
  });

  test("keeps the token out of curl's argv", () => {
    const curlLines = script
      .split("\n")
      .filter((line) => line.includes("curl -") || line.includes("--data"))
      .join("\n");
    expect(curlLines).not.toContain("$token");
    expect(script).toContain("-K -");
  });
});
