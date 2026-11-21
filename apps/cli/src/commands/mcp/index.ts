import type { Argv, CommandModule } from "yargs";
import { mcpPullCommand } from "./pull";

/** `scarn mcp <command>`: MCP tool catalogs for the pipeline builder. */
export const mcpCommand: CommandModule<object, object> = {
  command: "mcp <command>",
  describe: "Pull MCP servers' tool catalogs into the pipeline builder",
  builder: (argv: Argv<object>) =>
    argv
      .command(mcpPullCommand)
      .demandCommand(1, "An mcp command is required."),
  handler: () => undefined,
};
