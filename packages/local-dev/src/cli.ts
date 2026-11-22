/**
 * Runs the Scarn CLI from source (`apps/cli/src/index.ts`), so the CLI under
 * test is always the current code. Every call targets `BASE_URL` through
 * `SCARN_BASE_URL` rather than `--base-url`, which commands such as
 * `worker stop` and `worker status` reject.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { BASE_URL, MONOREPO_ROOT } from "./config";

const CLI_DIR = path.join(MONOREPO_ROOT, "apps", "cli");
const CLI_ENTRYPOINT = path.join(CLI_DIR, "src", "index.ts");

/**
 * Keeps the local-dev background worker (discovery file, settings, logs,
 * lock) apart from an installed `scarn` worker and a `scarn-dev` link, which
 * may be bound to another server.
 */
const WORKER_INSTANCE = "scarn-local-dev";

/**
 * The `bin/scarn` shim normally sets this to its bundled copy of the
 * devcontainer CLI. From source there is no shim, so point it at the upstream
 * package, whose layout already has the `scripts/` assets beside `dist/`.
 */
function devcontainerScriptEnv(): Record<string, string> {
  if (process.env["SCARN_DEVCONTAINER_SCRIPT"]) return {};
  return {
    SCARN_DEVCONTAINER_SCRIPT: Bun.resolveSync(
      "@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js",
      CLI_DIR,
    ),
  };
}

export interface CliResult {
  exitCode: number;
}

export function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...args], {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...devcontainerScriptEnv(),
        SCARN_BASE_URL: BASE_URL,
        SCARN_WORKER_INSTANCE: WORKER_INSTANCE,
      },
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ exitCode: code ?? (signal ? 1 : 0) });
    });
  });
}

export async function runCliChecked(
  args: string[],
  cwd: string,
): Promise<void> {
  const { exitCode } = await runCli(args, cwd);
  if (exitCode !== 0) {
    throw new Error(
      `[local-dev] \`scarn ${args.join(" ")}\` exited with ${String(exitCode)} (cwd: ${cwd})`,
    );
  }
}
