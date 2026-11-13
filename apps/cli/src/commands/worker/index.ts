import type { Argv, CommandModule } from "yargs";
import { workerAddCommand } from "./add";
import { workerCancelCommand } from "./cancel";
import { workerConfigCommand } from "./config";
import { workerLogsCommand } from "./logs";
import { workerRemoveCommand } from "./remove";
import { workerStartCommand } from "./start";
import { workerStatusCommand } from "./status";
import { workerStopCommand } from "./stop";

/**
 * `scarn worker <command>`: controls this machine's background worker for
 * the CLI instance (`scarn`, `scarn-dev`, or `SCARN_WORKER_INSTANCE`).
 */
export const workerCommand: CommandModule<object, object> = {
  command: "worker <command>",
  describe: "Control this machine's background worker",
  builder: (argv: Argv<object>) =>
    argv
      .command(workerStartCommand)
      .command(workerStopCommand)
      .command(workerStatusCommand)
      .command(workerLogsCommand)
      .command(workerConfigCommand)
      .command(workerAddCommand)
      .command(workerRemoveCommand)
      .command(workerCancelCommand)
      .demandCommand(1),
  handler: () => {},
};
