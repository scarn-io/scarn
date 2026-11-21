/**
 * `scarn mcp pull [server] [--handle file#export] [--all] [--check]`: list an
 * MCP server's tools and write its lock and generated catalog into
 * `.scarn/pipeline-builder/mcp/`. See `lib/mcp-pull.ts`.
 */
import { join } from "node:path";
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  discoverRepoAgentTools,
  findGitRoot,
  PIPELINE_BUILDER_DIR,
  readLocalEnvVars,
  resolveScarnBaseUrl,
  SdkMcpToolLister,
} from "@scarn/worker";
import { CliError } from "../../lib/cli-error";
import { withReporter } from "../../lib/command-output";
import { createManagedConnectionsAdapters } from "../../lib/design-managed-connections-adapters";
import { importMcpHandlesViaSubprocess } from "../../lib/mcp-handle-import";
import {
  parseHandleSpecifier,
  runMcpPull,
  type McpPullPorts,
  type McpPullSelection,
} from "../../lib/mcp-pull";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
} from "../../lib/resolve-project-ref";

export type McpPullArguments = {
  server: string | undefined;
  handle: string | undefined;
  all: boolean;
  check: boolean;
  project: string | undefined;
  baseUrl: string | undefined;
};

function processEnvStrings(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function buildMcpPullPorts(input: {
  projectRoot: string;
  builderDir: string;
  args: McpPullArguments;
}): McpPullPorts {
  const { projectRoot, builderDir, args } = input;
  return {
    discoverServers: async () =>
      (await discoverRepoAgentTools(projectRoot)).servers,
    readToolEnv: async () => ({
      ...processEnvStrings(),
      ...(await readLocalEnvVars(projectRoot)),
    }),
    mcpToolLister: new SdkMcpToolLister({ repoRoot: projectRoot }),
    importHandles: (request) =>
      importMcpHandlesViaSubprocess({ builderDir, request }),
    resolveProject: async () => {
      const baseUrl = resolveScarnBaseUrl(args.baseUrl);
      const ref = await pickProjectRef(args.project, projectRoot);
      if (ref === undefined) {
        throw new CliError("no_project_id", NO_PROJECT_MESSAGE);
      }
      const { id: projectId } = await resolveCliProjectRef({
        baseUrl,
        ref,
        action: PROJECT_ACTIONS.mcp,
      });
      return { baseUrl, projectId };
    },
    ...createManagedConnectionsAdapters(),
  };
}

function selectionFrom(args: McpPullArguments): McpPullSelection | undefined {
  if (args.handle !== undefined) {
    return { kind: "handle", ...parseHandleSpecifier(args.handle) };
  }
  if (args.server !== undefined) return { kind: "server", server: args.server };
  return args.all ? { kind: "all" } : undefined;
}

export const runMcpPullCommand = (args: McpPullArguments): Promise<void> =>
  withReporter("mcp-pull", async ({ reporter }) => {
    const projectRoot = (await findGitRoot(process.cwd())) ?? process.cwd();
    const builderDir = join(projectRoot, PIPELINE_BUILDER_DIR);
    await runMcpPull({
      builderDir,
      selection: selectionFrom(args),
      check: args.check,
      reporter,
      ports: buildMcpPullPorts({ projectRoot, builderDir, args }),
    });
  });

export const mcpPullCommand: CommandModule<object, McpPullArguments> = {
  command: "pull [server]",
  describe: `List an MCP server's tools and write its lock and typed catalog into ${PIPELINE_BUILDER_DIR}/mcp`,
  builder: (argv: Argv<object>) =>
    argv
      .positional("server", {
        describe:
          "The server's name in this repository's MCP config, or a defineMcp handle's name",
        type: "string",
      })
      .option("handle", {
        type: "string",
        describe:
          "Pull the defineMcp handle exported by a builder file, as <file>#<export> (e.g. mcps.ts#notion)",
      })
      .option("all", {
        type: "boolean",
        default: false,
        describe: "Re-pull every server that already has a lock",
      })
      .option("check", {
        type: "boolean",
        default: false,
        describe:
          "Write nothing; exit non-zero when a locked server's live tools differ from its lock",
      })
      .option("project", {
        type: "string",
        describe:
          'For a managed connection: the project, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
      })
      .option("baseUrl", {
        alias: "base-url",
        type: "string",
        describe: "Scarn app base URL",
      })
      .check((argv) => {
        const picked = [
          argv.server !== undefined,
          argv.handle !== undefined,
          argv.all,
        ].filter(Boolean).length;
        if (picked > 1) {
          return "Pass only one of <server>, --handle and --all.";
        }
        if (picked === 0 && !argv.check) {
          return "Name a server, or pass --handle, --all or --check.";
        }
        return true;
      }),
  handler: (args: ArgumentsCamelCase<McpPullArguments>) =>
    runMcpPullCommand(args),
};
