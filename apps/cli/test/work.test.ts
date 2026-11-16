/**
 * Black-box CLI tests for `scarn work`'s checkout guard: it must run inside a
 * git repository, and it no longer resolves or verifies a source branch, so
 * any checkout (even an unpushed branch) proceeds to the (expected,
 * pre-existing) "not signed in" failure. Mirrors `init.test.ts`'s runCli +
 * fake-HOME style.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hasReporterLine, runCli, type SpawnResult } from "./utils";

// Each test builds real git repos and spawns the CLI from source; under a
// loaded machine (test-all-workspaces) that overruns bun's 5s default.
setDefaultTimeout(15_000);

const FAKE_PROJECT = "acme/web-app";

function runWork(
  args: readonly string[],
  options: { cwd: string; home: string },
): Promise<SpawnResult> {
  return runCli(["work", FAKE_PROJECT, ...args], {
    cwd: options.cwd,
    env: { HOME: options.home },
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A bare "remote" repo + a clone of it, both under a fresh temp root. */
function buildRepoWithOrigin(): {
  root: string;
  workspace: string;
  remote: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "scarn-work-cli-"));
  const remote = resolve(root, "remote.git");
  const workspace = resolve(root, "workspace");

  git(root, ["init", "--bare", "-b", "main", remote]);

  const seed = resolve(root, "seed");
  git(root, ["clone", remote, seed]);
  git(seed, ["config", "user.email", "seed@scarn.io"]);
  git(seed, ["config", "user.name", "Seed"]);
  execFileSync("git", [
    "-C",
    seed,
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "init",
  ]);
  git(seed, ["push", "origin", "main"]);

  git(root, ["clone", remote, workspace]);
  git(workspace, ["config", "user.email", "workspace@scarn.io"]);
  git(workspace, ["config", "user.name", "Workspace"]);

  return { root, workspace, remote };
}

describe("scarn work", () => {
  test("--help no longer offers the foreground loop's flags or --source-branch", async () => {
    const result = await runCli(["work", "--help"]);
    for (const flag of [
      "--once",
      "--workerId",
      "--batchSize",
      "--pollIntervalMs",
      "--max-poll-interval-ms",
      "--connected-max-poll-interval-ms",
      "--leaseDurationSeconds",
      "--source-branch",
    ]) {
      expect(result.stdout).not.toContain(flag);
    }
  });

  test("does not check the current branch against origin", async () => {
    const { root, workspace } = buildRepoWithOrigin();
    try {
      git(workspace, ["checkout", "-b", "feature-never-pushed"]);
      const home = mkdtempSync(resolve(tmpdir(), "scarn-work-home-"));
      try {
        const result = await runWork([], { cwd: workspace, home });
        expect(hasReporterLine(result.stderr, "does not exist on origin")).toBe(
          false,
        );
        expect(result.exitCode).toBe(1);
        expect(hasReporterLine(result.stderr, "Not signed in")).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to run outside a git repository", async () => {
    const notARepo = mkdtempSync(resolve(tmpdir(), "scarn-work-norepo-"));
    const home = mkdtempSync(resolve(tmpdir(), "scarn-work-home-"));
    try {
      const result = await runWork([], { cwd: notARepo, home });
      expect(result.exitCode).toBe(1);
      expect(
        hasReporterLine(result.stderr, "Not inside a git repository"),
      ).toBe(true);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
