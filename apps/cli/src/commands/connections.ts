/**
 * `scarn connections list | connect <name> | reconnect <name>`: the project's
 * managed MCP connections, and signing one in from the terminal through a
 * loopback redirect. See `lib/connections-loopback.ts`.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  discoverRepoAgentTools,
  findGitRoot,
  resolveScarnBaseUrl,
} from "@scarn/worker";
import { openBrowser } from "../auth/browser";
import { connectApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import {
  createConnectionsApi,
  type ConnectionsApi,
  type ManagedConnection,
} from "../lib/connections-api";
import { resolveConnectTarget } from "../lib/connections-custom";
import {
  accountLine,
  runLoopbackSignIn,
  type LoopbackSignInTarget,
} from "../lib/connections-loopback";
import { bindLoopbackCallback } from "../lib/loopback-callback";
import type { BaseReporter } from "../lib/reporter-types";
import {
  NO_PROJECT_MESSAGE,
  pickProjectRef,
  PROJECT_ACTIONS,
  resolveCliProjectRef,
} from "../lib/resolve-project-ref";

type CommonArguments = {
  project: string | undefined;
  baseUrl: string | undefined;
};

type SignInArguments = CommonArguments & {
  name: string;
  yes: boolean;
  browser: boolean;
};

type ConnectArguments = SignInArguments & {
  preset: string | undefined;
  scope: string[] | undefined;
};

const withCommonOptions = <T>(argv: Argv<T>) =>
  argv
    .option("project", {
      type: "string",
      describe:
        'The project, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
    })
    .option("baseUrl", {
      alias: "base-url",
      type: "string",
      describe: "Scarn app base URL",
    });

const withSignInOptions = <T>(argv: Argv<T>) =>
  withCommonOptions(argv)
    .positional("name", {
      type: "string",
      demandOption: true,
      describe: "The connection's name in the project",
    })
    .option("yes", {
      alias: "y",
      type: "boolean",
      default: false,
      describe:
        "Make the connection available to the project without asking (required when not on a TTY)",
    })
    .option("browser", {
      type: "boolean",
      default: true,
      describe:
        "Open the sign-in page in a browser (--no-browser prints the URL instead)",
    });

async function openProject(args: CommonArguments) {
  const baseUrl = resolveScarnBaseUrl(args.baseUrl);
  const ref = await pickProjectRef(args.project);
  if (ref === undefined)
    throw new CliError("no_project_id", NO_PROJECT_MESSAGE);
  const project = await resolveCliProjectRef({
    baseUrl,
    ref,
    action: PROJECT_ACTIONS.connections,
  });
  const { client } = await connectApi(baseUrl);
  return {
    projectId: project.id,
    projectRef: `${project.owner}/${project.slug}`,
    api: createConnectionsApi(client),
  };
}

function statusLine(connection: ManagedConnection): string {
  const serving =
    connection.state === "ready" ||
    connection.state === "ready_with_pending_reconnect";
  return serving && connection.account
    ? accountLine(connection.account, connection.label)
    : connection.state.replaceAll("_", " ");
}

async function findConnection(
  api: ConnectionsApi,
  projectId: string,
  name: string,
): Promise<ManagedConnection> {
  const connection = (await api.list(projectId)).find(
    (candidate) => candidate.name === name,
  );
  if (connection === undefined) {
    throw new CliError(
      "connection_not_found",
      `This project has no connection named "${name}". Run \`scarn connections list\` to see its connections.`,
    );
  }
  return connection;
}

async function connectTarget(
  api: ConnectionsApi,
  projectId: string,
  args: ConnectArguments,
  reporter: BaseReporter,
): Promise<LoopbackSignInTarget | null> {
  const projectRoot = (await findGitRoot(process.cwd())) ?? process.cwd();
  const { servers, skipped } = await discoverRepoAgentTools(projectRoot);
  return resolveConnectTarget({
    api,
    projectId,
    name: args.name,
    preset: args.preset,
    scopes: (args.scope ?? []).flatMap((scope) =>
      scope.split(/\s+/u).filter(Boolean),
    ),
    servers,
    skipped,
    yes: args.yes,
    reporter,
  });
}

async function signIn(
  args: SignInArguments,
  reporter: BaseReporter,
  resolveTarget: (
    api: ConnectionsApi,
    projectId: string,
  ) => Promise<LoopbackSignInTarget | null>,
): Promise<void> {
  const { projectId, projectRef, api } = await openProject(args);
  const target = await resolveTarget(api, projectId);
  if (target === null) return;
  const controller = new AbortController();
  const onInterrupt = () => {
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  try {
    await runLoopbackSignIn({
      projectId,
      projectRef,
      target,
      yes: args.yes,
      noBrowser: !args.browser,
      reporter,
      signal: controller.signal,
      ports: { api, bindListener: bindLoopbackCallback, openBrowser },
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

const listCommand: CommandModule<object, CommonArguments> = {
  command: "list",
  describe: "List the project's managed MCP connections",
  builder: (argv) => withCommonOptions(argv),
  handler: (args: ArgumentsCamelCase<CommonArguments>) =>
    withReporter("connections", async ({ reporter }) => {
      const { projectId, api } = await openProject(args);
      const connections = await api.list(projectId);
      if (connections.length === 0) {
        reporter.info("This project has no managed MCP connections.");
        return;
      }
      for (const connection of connections) {
        process.stdout.write(
          `${connection.name}\t${connection.label}\t${statusLine(connection)}\n`,
        );
      }
    }),
};

const connectCommand: CommandModule<object, ConnectArguments> = {
  command: "connect <name>",
  describe:
    "Sign a managed MCP connection in through your browser: the remote server named <name> in the project's MCP config, else the service <name>. A config entry without oauth.clientId whose url is a service's uses that service.",
  builder: (argv) =>
    withSignInOptions(argv)
      .option("preset", {
        type: "string",
        describe:
          "The service to connect, ignoring the MCP config (defaults to <name> when it is one)",
      })
      .option("scope", {
        type: "string",
        array: true,
        describe:
          "A scope for a server from the MCP config to ask for, instead of its oauth.scope (repeat for more). Not for services.",
      }),
  handler: (args: ArgumentsCamelCase<ConnectArguments>) =>
    withReporter("connections", ({ reporter }) =>
      signIn(args, reporter, (api, projectId) =>
        connectTarget(api, projectId, args, reporter),
      ),
    ),
};

const reconnectCommand: CommandModule<object, SignInArguments> = {
  command: "reconnect <name>",
  describe: "Sign an existing managed MCP connection in again",
  builder: (argv) => withSignInOptions(argv),
  handler: (args: ArgumentsCamelCase<SignInArguments>) =>
    withReporter("connections", ({ reporter }) =>
      signIn(args, reporter, async (api, projectId) => {
        const connection = await findConnection(api, projectId, args.name);
        return {
          kind: "reconnect",
          connectionId: connection.id,
          suppliedRedirectUri: connection.suppliedClient?.redirectUri ?? null,
        };
      }),
    ),
};

/** `scarn connections <command>`: the project's managed MCP connections. */
export const connectionsCommand: CommandModule<object, object> = {
  command: "connections <command>",
  describe: "Manage the project's managed MCP connections",
  builder: (argv: Argv<object>) =>
    argv
      .command(listCommand)
      .command(connectCommand)
      .command(reconnectCommand)
      .demandCommand(1, "A connections command is required."),
  handler: () => undefined,
};
