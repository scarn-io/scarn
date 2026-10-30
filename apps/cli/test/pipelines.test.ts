import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasReporterLine, reporterLines, runCli } from "./utils";

// Spawns the CLI from source; under a loaded machine (test-all-workspaces)
// that overruns bun's 5s default.
setDefaultTimeout(15_000);

function createFakeGitRoot(dir: string): void {
  mkdirSync(join(dir, ".git"));
}

describe("scarn pipelines", () => {
  describe("help output", () => {
    test("pipelines --help lists init and push subcommands", async () => {
      const result = await runCli(["pipelines", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("push");
      expect(result.stdout).toContain("design");
      for (const command of ["validate", "publish", "activate", "run"]) {
        expect(result.stdout).toContain(`scarn pipelines ${command}`);
      }
    });

    test("run --help shows --version as a run option, not the CLI version flag", async () => {
      const result = await runCli(["pipelines", "run", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--work-item-id");
      expect(result.stdout).toContain(
        "Run this published version instead of the",
      );
      expect(result.stdout).not.toMatch(/--version\s+Show version number/);
    });

    test("activate --help takes the key and version positionals", async () => {
      const result = await runCli(["pipelines", "activate", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("<key> <version>");
    });

    test("pull --help documents the single-document --key form", async () => {
      const result = await runCli(["pipelines", "pull", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--key");
      expect(result.stdout).toContain("--version");
    });
  });

  describe("pipeline document commands", () => {
    test("pull rejects --version without --key", async () => {
      const result = await runCli(["pipelines", "pull", "--version", "2"]);

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "--version and --out require --key.",
      );
    });

    test("publish fails on an unreadable file before signing in", async () => {
      const fakeHome = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-publish-home-"),
      );
      try {
        const result = await runCli(
          ["pipelines", "publish", join(fakeHome, "missing.json")],
          { env: { HOME: fakeHome } },
        );

        expect(result.exitCode).toBe(1);
        expect(hasReporterLine(result.stderr, "Could not read")).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test("validate a document with no key fails without contacting the server", async () => {
      const fakeHome = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-validate-home-"),
      );
      try {
        const file = join(fakeHome, "pipeline.json");
        writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
        const result = await runCli(["pipelines", "validate", file], {
          env: { HOME: fakeHome },
        });

        expect(result.exitCode).toBe(1);
        expect(hasReporterLine(result.stderr, 'has no "key"')).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test("top-level --help includes pipelines command", async () => {
      const result = await runCli(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pipelines");
    });
  });

  describe("pipelines init", () => {
    test("creates .scarn/pipeline-builder directory with all scaffold files", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        const result = await runCli(["pipelines", "init"], {
          cwd: fakeProjectDir,
        });

        expect(result.exitCode).toBe(0);

        const builderDir = join(fakeProjectDir, ".scarn", "pipeline-builder");
        expect(existsSync(builderDir)).toBe(true);
        expect(existsSync(join(builderDir, "package.json"))).toBe(true);
        expect(existsSync(join(builderDir, "tsconfig.json"))).toBe(true);
        expect(existsSync(join(builderDir, ".gitignore"))).toBe(true);
        expect(existsSync(join(builderDir, "bug-pipeline.ts"))).toBe(true);
        expect(existsSync(join(builderDir, "bug-pipeline.json"))).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    test("bug-pipeline.ts contains step and pipeline definitions", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        await runCli(["pipelines", "init"], { cwd: fakeProjectDir });

        const starterFile = join(
          fakeProjectDir,
          ".scarn",
          "pipeline-builder",
          "bug-pipeline.ts",
        );
        expect(existsSync(starterFile)).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    test("logs a created message for each file", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        const result = await runCli(["pipelines", "init"], {
          cwd: fakeProjectDir,
        });
        // Created messages are now human status on stderr: `✓ Created <path>`.
        const createdLines = reporterLines(result.stderr).filter((line) =>
          line.includes("Created"),
        );

        for (const file of [
          "package.json",
          "tsconfig.json",
          ".gitignore",
          "bug-pipeline.ts",
          "bug-pipeline.json",
        ]) {
          expect(createdLines.some((line) => line.includes(file))).toBe(true);
        }
        const output = reporterLines(result.stderr).join("\n");
        const push = output.indexOf("scarn pipelines push");
        const build = output.indexOf("scarn pipelines build");
        const publish = output.indexOf(
          "scarn pipelines publish bug-pipeline.json",
        );
        expect(push).toBeGreaterThan(-1);
        expect(build).toBeGreaterThan(push);
        expect(publish).toBeGreaterThan(build);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    test("is idempotent — skips existing files on second run", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-init-test-"),
      );
      try {
        createFakeGitRoot(fakeProjectDir);
        await runCli(["pipelines", "init"], { cwd: fakeProjectDir });
        const second = await runCli(["pipelines", "init"], {
          cwd: fakeProjectDir,
        });

        expect(second.exitCode).toBe(0);
        // Skipped messages are now on stderr: `! Skipped <path> (already exists)`.
        expect(hasReporterLine(second.stderr, "Skipped")).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });

    test("fails outside the root of a git repository", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-init-test-"),
      );
      try {
        const result = await runCli(["pipelines", "init"], {
          cwd: fakeProjectDir,
        });

        expect(result.exitCode).toBe(1);
        // The error surfaces on stderr as `✗ …git repository…`.
        expect(hasReporterLine(result.stderr, "git repository")).toBe(true);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
      }
    });
  });

  describe("pipelines design", () => {
    test("design --help shows its arguments", async () => {
      const result = await runCli(["pipelines", "design", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("project");
      expect(result.stdout).toContain("--base-url");
    });

    test("rejects unknown options (strict mode)", async () => {
      const result = await runCli(["pipelines", "design", "--nope"]);

      expect(result.exitCode).toBe(1);
    });

    test("refuses to run without an interactive terminal", async () => {
      // runCli gives the child pipes, not a tty. The TUI cannot render into
      // a pipe, so the command must bail before doing any provisioning work —
      // this also proves the handler is wired up and its args parse.
      const fakeHome = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-design-home-"),
      );
      try {
        const result = await runCli(["pipelines", "design", "acme/web-app"], {
          env: { HOME: fakeHome },
        });

        expect(result.exitCode).toBe(1);
        expect(
          reporterLines(result.stderr).some((line) =>
            line.includes("interactive terminal"),
          ),
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe("pipelines push", () => {
    test("push --help shows project positional argument", async () => {
      const result = await runCli(["pipelines", "push", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("project");
    });

    test("exits with error and helpful message when not signed in", async () => {
      const fakeHome = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-push-test-"),
      );
      try {
        const result = await runCli(["pipelines", "push", "acme/web-app"], {
          env: { HOME: fakeHome },
        });

        expect(result.exitCode).toBe(1);
        // The not-signed-in error now surfaces on stderr via reporter.error.
        expect(
          reporterLines(result.stderr).some((line) =>
            line.toLowerCase().includes("not signed in"),
          ),
        ).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test("fails without a project argument or config file", async () => {
      const fakeProjectDir = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-push-noproject-"),
      );
      const fakeHome = mkdtempSync(
        join(tmpdir(), "scarn-pipelines-push-home-"),
      );
      try {
        const result = await runCli(["pipelines", "push"], {
          cwd: fakeProjectDir,
          env: { HOME: fakeHome },
        });

        expect(result.exitCode).toBe(1);
      } finally {
        rmSync(fakeProjectDir, { recursive: true, force: true });
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });
});
