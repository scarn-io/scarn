import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  addComment,
  answerQuestion,
  type WorkItemActionClient,
} from "@scarn/shared-core";
import { resolveScarnBaseUrl } from "@scarn/worker";
import {
  asCliAction,
  realActionIo,
  type ActionIo,
} from "../lib/action-support";
import { connectApi, type AuthenticatedApi } from "../lib/cli-api-client";
import { withReporter } from "../lib/command-output";
import {
  withProjectOptions,
  type ProjectArguments,
} from "../lib/connect-project";
import { nextHint, writeJson, writeText } from "../lib/output";
import { readBody } from "../lib/read-body";
import {
  createWorkItemRefPorts,
  resolveWorkItemRef,
  type ResolvedWorkItemRef,
} from "../lib/resolve-work-item-ref";

/**
 * `scarn work-items comment` and `work-items answer`: the safe actions on a
 * work item. Neither asks for confirmation.
 */

type ActionConnection = {
  client: WorkItemActionClient;
  headers: { Authorization: string };
};

export interface WorkItemActionDependencies {
  connect(args: ProjectArguments): Promise<ActionConnection>;
  resolveRef(ref: string, args: ProjectArguments): Promise<ResolvedWorkItemRef>;
  io: ActionIo;
}

/** The generated client matches {@link WorkItemActionClient} only at runtime. */
const asActionClient = (client: AuthenticatedApi["client"]) =>
  client as unknown as WorkItemActionClient;

export const realWorkItemActionDependencies: WorkItemActionDependencies = {
  async connect(args) {
    const api = await connectApi(resolveScarnBaseUrl(args.baseUrl));
    return { client: asActionClient(api.client), headers: api.headers };
  },
  resolveRef: (ref, args) =>
    resolveWorkItemRef(ref, createWorkItemRefPorts(args)),
  io: realActionIo,
};

interface CommentArguments extends ProjectArguments {
  ref: string;
  body: string;
  json: boolean;
}

const withActionArguments = <T>(argv: Argv<T>) =>
  withProjectOptions(argv)
    .positional("ref", {
      describe: "The work item: its id, tracker URL, or platform key",
      type: "string",
      demandOption: true,
    })
    .option("body", {
      describe: "The text: as given, @path to read a file, or - for stdin",
      type: "string",
      nargs: 1,
      demandOption: true,
    })
    .option("json", {
      describe: "Print the API response as a single JSON document",
      type: "boolean",
      default: false,
    });

const commentCommand = (
  deps: WorkItemActionDependencies,
): CommandModule<object, CommentArguments> => ({
  command: "comment <ref>",
  describe: "Add a comment to a work item",
  builder: (argv: Argv<object>) => withActionArguments(argv),
  handler: (args: ArgumentsCamelCase<CommentArguments>) =>
    withReporter("work-items-comment", () =>
      asCliAction(async () => {
        const body = await readBody(args.body, deps.io.body);
        const { workItemId } = await deps.resolveRef(args.ref, args);
        const { client, headers } = await deps.connect(args);
        const comment = await addComment({
          client,
          headers,
          workItemId,
          body,
        });
        if (args.json) {
          writeJson(comment);
          return;
        }
        writeText([
          `Added comment ${comment.id} to work item ${workItemId}.`,
          nextHint(`scarn work-items comments ${args.ref}`),
        ]);
      }),
    ),
});

interface AnswerArguments extends CommentArguments {
  questionId: string;
}

const answerCommand = (
  deps: WorkItemActionDependencies,
): CommandModule<object, AnswerArguments> => ({
  command: "answer <ref> <questionId>",
  describe:
    "Answer a pipeline run's open question; the step waiting on it resumes",
  builder: (argv: Argv<object>) =>
    withActionArguments(argv).positional("questionId", {
      describe: "The question ID, as `scarn inbox` or `work-items view` shows",
      type: "string",
      demandOption: true,
    }),
  handler: (args: ArgumentsCamelCase<AnswerArguments>) =>
    withReporter("work-items-answer", () =>
      asCliAction(async () => {
        const body = await readBody(args.body, deps.io.body);
        const { workItemId } = await deps.resolveRef(args.ref, args);
        const { client, headers } = await deps.connect(args);
        const { question, comment } = await answerQuestion({
          client,
          headers,
          workItemId,
          questionId: args.questionId,
          body,
        });
        if (args.json) {
          writeJson(comment);
          return;
        }
        writeText([
          `Answered question ${question.questionId} with comment ${comment.id}; pipeline run ${question.pipelineExecutionId} resumes.`,
          nextHint(`scarn work-items comments ${args.ref}`),
          nextHint(`scarn runs list --work-item ${args.ref}`),
        ]);
      }),
    ),
});

/** Registers the action verbs on `scarn work-items`, next to the reads. */
export const withWorkItemActionCommands = (
  argv: Argv<object>,
  deps: WorkItemActionDependencies,
) => argv.command(commentCommand(deps)).command(answerCommand(deps));
