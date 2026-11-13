import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  formatInbox,
  gatherInbox,
  type InboxReadClient,
} from "@scarn/shared-core";
import type { AuthenticatedApi } from "../lib/cli-api-client";
import { CliError } from "../lib/cli-error";
import { withReporter } from "../lib/command-output";
import {
  connectProject,
  withProjectOptions,
  type ProjectArguments,
} from "../lib/connect-project";
import {
  withOutputOptions,
  writeJson,
  writeText,
  type OutputArguments,
} from "../lib/output";
import { PROJECT_ACTIONS } from "../lib/resolve-project-ref";

/**
 * `scarn inbox`: what waits on the signed-in user in a project — the badge
 * counts, open questions and decisions, Tasks waiting on them, failed Tasks
 * they started, comment drafts to approve, and the latest notifications.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type InboxConnection = {
  client: InboxReadClient;
  headers: { Authorization: string };
  projectId: string;
};

/** What `inbox` reaches the API through; tests pass a fake. */
export interface InboxDependencies {
  connectProject(args: ProjectArguments): Promise<InboxConnection>;
}

/**
 * The generated `ScarnClient` types every nullable field as `unknown`, so it
 * matches {@link InboxReadClient} at runtime but not structurally; this is
 * the one place it is asserted.
 */
const asReadClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as InboxReadClient;

export const realInboxDependencies: InboxDependencies = {
  async connectProject(args) {
    const api = await connectProject(args, PROJECT_ACTIONS.inspect);
    return {
      client: asReadClient(api.client),
      headers: api.headers,
      projectId: api.projectId,
    };
  },
};

function inboxLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CliError(
      "invalid_usage",
      `--limit must be a whole number from 1 to ${String(MAX_LIMIT)}, got ${String(limit)}.`,
    );
  }
  return limit;
}

interface InboxArguments extends ProjectArguments, OutputArguments {}

/** Builds `scarn inbox`; tests pass fake dependencies. */
export function createInboxCommand(
  deps: InboxDependencies = realInboxDependencies,
): CommandModule<object, InboxArguments> {
  return {
    command: "inbox",
    describe:
      "Show what waits on you: questions, decisions, Tasks, comment drafts and notifications",
    builder: (argv: Argv<object>) =>
      withOutputOptions(withProjectOptions(argv)),
    handler: (args: ArgumentsCamelCase<InboxArguments>) =>
      withReporter("inbox", async () => {
        const limit = inboxLimit(args.limit);
        const { client, headers, projectId } = await deps.connectProject(args);
        const gathered = await gatherInbox({
          client,
          headers,
          projectId,
          limit,
        });
        if (args.json) writeJson(gathered);
        else writeText(formatInbox(gathered));
      }),
  };
}

export const inboxCommand = createInboxCommand();
