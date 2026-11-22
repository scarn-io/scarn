/**
 * Works the sandbox checkout from source, against `BASE_URL`, on the
 * `scarn-local-dev` worker instance.
 *
 * - Default: `scarn work`, which starts the background
 *   worker when none runs and adds the project to it. Extra arguments are
 *   passed through, e.g. `-c 4`, `-k`, `--work-item-id <id>` or `--dry-run`.
 * - `--once`: `worker start --foreground --once` in this process instead,
 *   with the extra arguments passed through.
 */
import { runCli } from "./cli";
import { ROOT_DIR } from "./config";
import { repoPaths } from "./repo";

const checkout = repoPaths(ROOT_DIR).checkout;
const args = process.argv.slice(2);

function withoutFlag(flag: string): string[] {
  return args.filter((arg) => arg !== flag);
}

async function main(): Promise<number> {
  if (args.includes("--once")) {
    const { exitCode } = await runCli(
      ["worker", "start", "--foreground", "--once", ...withoutFlag("--once")],
      checkout,
    );
    return exitCode;
  }
  const { exitCode } = await runCli(["work", ...args], checkout);
  return exitCode;
}

process.exit(await main());
