/**
 * Forwards `scarn worker <args>` to the from-source CLI in the sandbox
 * checkout, on the `scarn-local-dev` instance against `BASE_URL`, e.g.
 * `bun worker status`, `bun worker logs -f` or `bun worker stop`.
 */
import { runCli } from "./cli";
import { ROOT_DIR } from "./config";
import { repoPaths } from "./repo";

const checkout = repoPaths(ROOT_DIR).checkout;

const { exitCode } = await runCli(
  ["worker", ...process.argv.slice(2)],
  checkout,
);
process.exit(exitCode);
