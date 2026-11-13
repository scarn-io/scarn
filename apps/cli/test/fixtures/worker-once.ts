/**
 * Parses `worker start --foreground --once …` through yargs like the CLI
 * does, with the project lookup and the project loop faked, and prints the
 * loop's options as JSON on stdout. Exits 0 once the pass has settled.
 */
import yargs from "yargs/yargs";
import { createWorkerStartCommand } from "../../src/commands/worker/start";
import { FAKE_PROJECT_ID } from "../worker-host-fakes";

const startCommand = createWorkerStartCommand({
  once: {
    resolveTarget: () =>
      Promise.resolve({
        baseUrl: "http://scarn.test",
        projectRef: "acme/app",
        projectId: FAKE_PROJECT_ID,
        repoDir: process.cwd(),
        sourceBranch: null,
        sourceBranchWarning: undefined,
      }),
    runProjectWork: (options) => {
      const { readLocalEnv, reporter, dest, ...printable } = options;
      void readLocalEnv;
      void reporter;
      void dest;
      process.stdout.write(`${JSON.stringify(printable)}\n`);
      return Promise.resolve({
        claimedCount: 0,
        processedCount: 0,
        skippedCount: 0,
      });
    },
  },
});

await yargs([
  "worker",
  "start",
  "--foreground",
  "--once",
  "acme/app",
  "-k",
  "-c",
  "2",
  "--work-item-id",
  "item-1",
])
  .command({
    command: "worker <command>",
    describe: "worker",
    builder: (argv) => argv.command(startCommand).demandCommand(1),
    handler: () => undefined,
  })
  .strict()
  .exitProcess(false)
  .fail((message, error) => {
    throw error instanceof Error ? error : new Error(message);
  })
  .parseAsync();
process.exit(0);
