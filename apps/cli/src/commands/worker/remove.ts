/**
 * `scarn worker remove <project>`: removes a project from the instance's
 * running background worker over `DELETE /projects/:projectId`. Its saved
 * settings go at once; runs already going finish, and the command names
 * them. `<project>` is a project ID or the ref of a project on the worker,
 * looked up in the worker's `/status`, so no sign-in is needed.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { resolveWorkerInstance, type RunningWorker } from "@scarn/worker";
import { CliError } from "../../lib/cli-error";
import { withReporter } from "../../lib/command-output";
import {
  controlData,
  requireRunningWorker,
  type ConnectToWorkerDeps,
} from "./connect";
import { drainingMessage } from "./stop";

export type WorkerRemoveArguments = { project: string };

async function resolveWorkerProject(
  instance: string,
  worker: RunningWorker,
  project: string,
): Promise<{ projectId: string; projectRef: string }> {
  const status = await controlData(
    "read the worker's status",
    worker.client.status.get({ query: { recentRuns: 0 } }),
  );
  const match = status.projects.find(
    (p) => p.projectId === project || p.projectRef === project,
  );
  if (!match) {
    throw new CliError(
      "project_not_found",
      `Worker instance ${instance} has no project ${project}. See \`${instance} worker status\`.`,
    );
  }
  return { projectId: match.projectId, projectRef: match.projectRef };
}

export async function runWorkerRemove(
  arguments_: WorkerRemoveArguments,
  deps: ConnectToWorkerDeps = {},
): Promise<void> {
  await withReporter("worker-remove-command", async ({ reporter }) => {
    const instance = resolveWorkerInstance();
    const worker = await requireRunningWorker(
      instance,
      { checkVersion: true },
      deps,
    );
    const { projectId, projectRef } = await resolveWorkerProject(
      instance,
      worker,
      arguments_.project,
    );
    const result = await controlData(
      `remove ${projectRef} from the worker`,
      worker.client.projects({ projectId }).delete(),
    );
    if (!result.removed) {
      reporter.info(
        `${projectRef} was already removed from worker instance ${instance}.`,
      );
      return;
    }
    reporter.success(`Removed ${projectRef} from worker instance ${instance}.`);
    if (result.drainingRuns.length > 0) {
      reporter.info(
        `${drainingMessage(result.drainingRuns)}; they finish normally.`,
      );
    }
  });
}

export function createWorkerRemoveCommand(
  deps: ConnectToWorkerDeps = {},
): CommandModule<object, WorkerRemoveArguments> {
  return {
    command: "remove <project>",
    describe:
      "Remove a project from the background worker; its current runs finish",
    builder: (argv: Argv<object>) =>
      argv.positional("project", {
        describe: "The project's ID, or its owner/slug",
        type: "string",
        demandOption: true,
      }),
    handler: (arguments_: ArgumentsCamelCase<WorkerRemoveArguments>) =>
      runWorkerRemove(arguments_, deps),
  };
}

export const workerRemoveCommand = createWorkerRemoveCommand();
