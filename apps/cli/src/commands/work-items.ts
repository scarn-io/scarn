import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  formatActivity,
  formatCommentDrafts,
  formatComments,
  formatWorkItem,
  formatWorkItemList,
  gatherWorkItem,
  type ApiErrorBody,
  type WorkItemReadClient,
} from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import {
  connectApi,
  describeApiError,
  type AuthenticatedApi,
} from "../lib/cli-api-client";
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
import {
  createWorkItemRefPorts,
  resolveWorkItemRef,
  type ResolvedWorkItemRef,
} from "../lib/resolve-work-item-ref";
import {
  realWorkItemActionDependencies,
  withWorkItemActionCommands,
  type WorkItemActionDependencies,
} from "./work-items-actions";

/**
 * `scarn work-items`: read work items, their comments and their activity.
 * Every verb prints text by default and the API body with `--json`. The
 * action verbs (`comment`, `answer`) live in `./work-items-actions.ts`.
 */

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const DEFAULT_ENTRY_LIMIT = 50;

type ReadConnection = {
  client: WorkItemReadClient;
  headers: { Authorization: string };
};

/** What the verbs reach the API through; tests pass fakes. */
export interface WorkItemsDependencies {
  connect(args: ProjectArguments): Promise<ReadConnection>;
  connectProject(
    args: ProjectArguments,
  ): Promise<ReadConnection & { projectId: string }>;
  resolveRef(ref: string, args: ProjectArguments): Promise<ResolvedWorkItemRef>;
}

/**
 * The generated `ScarnClient` types every nullable field as `unknown`, so it
 * matches {@link WorkItemReadClient} at runtime but not structurally; this is
 * the one place it is asserted (see `runs.ts` for the same cast).
 */
const asReadClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as WorkItemReadClient;

const realDependencies: WorkItemsDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asReadClient(api.client), headers: api.headers };
  },
  async connectProject(args) {
    const api = await connectProject(args, PROJECT_ACTIONS.inspect);
    return {
      client: asReadClient(api.client),
      headers: api.headers,
      projectId: api.projectId,
    };
  },
  resolveRef: (ref, args) =>
    resolveWorkItemRef(ref, createWorkItemRefPorts(args)),
};

function positiveLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CliError(
      "invalid_usage",
      `--limit must be a positive whole number, got ${String(limit)}.`,
    );
  }
  return limit;
}

function unwrap<T>(
  what: string,
  result:
    { data: T; error: undefined } | { data: undefined; error: ApiErrorBody },
): T {
  if (result.error !== undefined) {
    throw new CliError(
      "work_item_lookup_failed",
      `Could not load ${what}: ${describeApiError(result.error)}`,
    );
  }
  return result.data;
}

const withRefPositional = <T>(argv: Argv<T>) =>
  argv.positional("ref", {
    describe: "The work item: its id, tracker URL, or platform key",
    type: "string",
    demandOption: true,
  });

// list

interface ListArguments extends ProjectArguments, OutputArguments {
  status: string | undefined;
  label: string[] | undefined;
  platform: string | undefined;
  assignee: string | undefined;
  updatedAfter: string | undefined;
  search: string | undefined;
}

const listCommand = (
  deps: WorkItemsDependencies,
): CommandModule<object, ListArguments> => ({
  command: "list",
  describe: "List the project's work items, most recently updated first",
  builder: (argv: Argv<object>) =>
    withOutputOptions(withProjectOptions(argv))
      .option("status", {
        type: "string",
        describe:
          "Latest run status: active, waiting, succeeded, failed or cancelled",
      })
      .option("label", {
        type: "string",
        array: true,
        describe: "Only items carrying this label (repeat for several)",
      })
      .option("platform", {
        type: "string",
        describe: "Tracker platform: github, jira, linear, scarn, …",
      })
      .option("assignee", {
        type: "string",
        describe: "me, none, or a user id",
      })
      .option("updatedAfter", {
        alias: "updated-after",
        type: "string",
        describe: "Updated within <N>h or <N>d, or since YYYY-MM-DD",
      })
      .option("search", {
        type: "string",
        describe: "Text to search titles, descriptions and keys for",
      }),
  handler: (args: ArgumentsCamelCase<ListArguments>) =>
    withReporter("work-items-list", async () => {
      const limit = positiveLimit(args.limit, DEFAULT_LIST_LIMIT);
      if (limit > MAX_LIST_LIMIT) {
        throw new CliError(
          "invalid_usage",
          `--limit can be at most ${String(MAX_LIST_LIMIT)}.`,
        );
      }
      const { client, headers, projectId } = await deps.connectProject(args);
      const page = unwrap(
        "work items",
        await client.projects.listProjectWorkItems({
          path: { projectId },
          query: {
            page: 1,
            pageSize: limit,
            sort: "updated-desc",
            q: args.search,
            status: args.status,
            labels: args.label,
            platform: args.platform,
            assignee: args.assignee,
            updatedAfter: args.updatedAfter,
          },
          headers,
        }),
      );
      if (args.json) writeJson(page);
      else writeText(formatWorkItemList(page));
    }),
});

// view

interface RefArguments extends ProjectArguments, OutputArguments {
  ref: string;
}

const viewCommand = (
  deps: WorkItemsDependencies,
): CommandModule<object, RefArguments> => ({
  command: "view <ref>",
  describe:
    "Show a work item with its blocks, children, questions, and latest runs and Tasks",
  builder: (argv: Argv<object>) =>
    withRefPositional(withOutputOptions(withProjectOptions(argv))),
  handler: (args: ArgumentsCamelCase<RefArguments>) =>
    withReporter("work-items-view", async () => {
      const { workItemId, projectId } = await deps.resolveRef(args.ref, args);
      const { client, headers } = await deps.connect(args);
      const gathered = await gatherWorkItem({
        client,
        headers,
        workItemId,
        projectId,
      });
      if (args.json) writeJson(gathered);
      else writeText(formatWorkItem(gathered));
    }),
});

// comments

interface CommentsArguments extends RefArguments {
  drafts: boolean;
}

const commentsCommand = (
  deps: WorkItemsDependencies,
): CommandModule<object, CommentsArguments> => ({
  command: "comments <ref>",
  describe: "Show a work item's comments, oldest first",
  builder: (argv: Argv<object>) =>
    withRefPositional(withOutputOptions(withProjectOptions(argv))).option(
      "drafts",
      {
        type: "boolean",
        default: false,
        describe: "Show agent comment drafts waiting for approval instead",
      },
    ),
  handler: (args: ArgumentsCamelCase<CommentsArguments>) =>
    withReporter("work-items-comments", async () => {
      const limit = positiveLimit(args.limit, DEFAULT_ENTRY_LIMIT);
      const { workItemId } = await deps.resolveRef(args.ref, args);
      const { client, headers } = await deps.connect(args);
      const query = { workItemId };
      if (args.drafts) {
        const drafts = unwrap(
          "comment drafts",
          await client.workItemCommentDrafts.listPendingCommentDrafts({
            query,
            headers,
          }),
        );
        const shown = drafts.slice(-limit);
        if (args.json) writeJson(shown);
        else
          writeText(
            formatCommentDrafts({
              workItemId,
              drafts: shown,
              total: drafts.length,
            }),
          );
        return;
      }
      const comments = unwrap(
        "comments",
        await client.workItemComments.listWorkItemComments({ query, headers }),
      );
      const shown = comments.slice(-limit);
      if (args.json) writeJson(shown);
      else
        writeText(
          formatComments({
            workItemId,
            comments: shown,
            total: comments.length,
          }),
        );
    }),
});

// activity

const activityCommand = (
  deps: WorkItemsDependencies,
): CommandModule<object, RefArguments> => ({
  command: "activity <ref>",
  describe: "Show a work item's activity log, oldest first",
  builder: (argv: Argv<object>) =>
    withRefPositional(withOutputOptions(withProjectOptions(argv))),
  handler: (args: ArgumentsCamelCase<RefArguments>) =>
    withReporter("work-items-activity", async () => {
      const limit = positiveLimit(args.limit, DEFAULT_ENTRY_LIMIT);
      const { workItemId } = await deps.resolveRef(args.ref, args);
      const { client, headers } = await deps.connect(args);
      const entries = unwrap(
        "activity",
        await client.workItems.listWorkItemActivity({
          path: { workItemId },
          headers,
        }),
      );
      const shown = entries.slice(-limit);
      if (args.json) writeJson(shown);
      else
        writeText(
          formatActivity({ workItemId, entries: shown, total: entries.length }),
        );
    }),
});

// parent

/** Builds `scarn work-items` over `deps`; tests pass fake dependencies. */
export function createWorkItemsCommand(
  deps: WorkItemsDependencies = realDependencies,
  actionDeps: WorkItemActionDependencies = realWorkItemActionDependencies,
): CommandModule<object, object> {
  return {
    command: "work-items <command>",
    describe:
      "Read work items, their comments and activity; comment or answer questions",
    builder: (argv) =>
      withWorkItemActionCommands(
        argv
          .command(listCommand(deps))
          .command(viewCommand(deps))
          .command(commentsCommand(deps))
          .command(activityCommand(deps)),
        actionDeps,
      ).demandCommand(1, "A work-items command is required."),
    handler: () => undefined,
  };
}

export const workItemsCommand = createWorkItemsCommand();
