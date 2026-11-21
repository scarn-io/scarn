/**
 * `scarn worker add [project]`: adds the project in the current checkout to
 * the instance's running background worker over `PUT /projects/:projectId`,
 * or updates its settings when it is already added. `scarn work` shares the
 * same steps after starting the worker.
 *
 * The project and repo root are resolved from the current directory, and the user ID from the login, before the worker is asked;
 * a project on another server than the instance's is refused.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  findGitRoot,
  loadAuthenticatedSession,
  resolveWorkerInstance,
  type ProjectSettingsInput,
  type RunningWorker,
} from "@scarn/worker";
import { CliError } from "../../lib/cli-error";
import { withReporter } from "../../lib/command-output";
import { notSignedInMessage } from "../../lib/ensure-signed-in";
import { nextHint, writeText } from "../../lib/output";
import type { BaseReporter } from "../../lib/reporter-types";
import {
  resolveWorkTarget,
  type ResolveWorkTargetInput,
  type WorkTarget,
} from "../../lib/resolve-work-target";
import {
  controlData,
  requireRunningWorker,
  type ConnectToWorkerDeps,
} from "./connect";
import { WorkerInstanceBaseUrlError } from "./instance-settings";

export type AddProjectArguments = {
  project: string | undefined;
  baseUrl: string | undefined;
  concurrency: number | undefined;
  preserveRuntimeOnComplete: boolean;
  workItemId: string | undefined;
};

export type ProjectSettingsDeps = {
  cwd?: string | undefined;
  findGitRoot?: ((cwd: string) => Promise<string | null>) | undefined;
  resolveTarget?:
    ((input: ResolveWorkTargetInput) => Promise<WorkTarget>) | undefined;
  resolveUserId?: ((baseUrl: string) => Promise<string | null>) | undefined;
};

export type WorkerAddDeps = ConnectToWorkerDeps & ProjectSettingsDeps;

export type AddProjectResult = {
  outcome: "added" | "updated" | "restarting" | "removed";
  settings: ProjectSettingsInput;
  /** Why the project's loop is in error after the change, or null. */
  error: string | null;
};

async function signedInUserId(baseUrl: string): Promise<string | null> {
  const authenticated = await loadAuthenticatedSession(baseUrl);
  return authenticated?.session.user.id ?? null;
}

function assertConcurrency(concurrency: number | undefined): void {
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) || concurrency < 0)
  ) {
    throw new CliError(
      "invalid_usage",
      "--concurrency must be a non-negative integer.",
    );
  }
}

/**
 * The settings `PUT /projects/:projectId` takes for the project in the
 * current checkout: its repo root and the signed-in user.
 */
export async function resolveProjectSettings(
  arguments_: AddProjectArguments,
  deps: ProjectSettingsDeps = {},
): Promise<ProjectSettingsInput> {
  assertConcurrency(arguments_.concurrency);
  const cwd = deps.cwd ?? process.cwd();
  const repoDir = await (deps.findGitRoot ?? findGitRoot)(cwd);
  if (!repoDir) {
    throw new CliError(
      "not_in_git_repo",
      "Not inside a git repository. Run this from inside your project's git repository.",
    );
  }
  const target = await (deps.resolveTarget ?? resolveWorkTarget)({
    project: arguments_.project,
    baseUrl: arguments_.baseUrl,
    cwd: repoDir,
  });
  const userId = await (deps.resolveUserId ?? signedInUserId)(target.baseUrl);
  if (!userId) {
    throw new CliError(
      "not_signed_in_noninteractive",
      notSignedInMessage(target.baseUrl),
    );
  }
  return {
    projectId: target.projectId,
    projectRef: target.projectRef,
    repoDir: target.repoDir,
    baseUrl: target.baseUrl,
    addedByUserId: userId,
    concurrency: arguments_.concurrency ?? null,
    workItemId: arguments_.workItemId ?? null,
    preserveRuntime: arguments_.preserveRuntimeOnComplete,
  };
}

/**
 * Adds or updates a project on a running worker. Throws
 * {@link WorkerInstanceBaseUrlError} when the project is on another server
 * than the instance's, and a `WorkerRequestFailedError` when the worker
 * refuses.
 */
export async function addProjectToWorker(
  instance: string,
  worker: RunningWorker,
  settings: ProjectSettingsInput,
): Promise<AddProjectResult> {
  const instanceBaseUrl = worker.discovery.baseUrl;
  if (instanceBaseUrl !== null && instanceBaseUrl !== settings.baseUrl) {
    throw new WorkerInstanceBaseUrlError(
      instance,
      instanceBaseUrl,
      settings.baseUrl,
    );
  }
  const { projectId, ...body } = settings;
  const result = await controlData(
    `add ${settings.projectRef} to the worker`,
    worker.client.projects({ projectId }).put(body),
  );
  const project = result.project;
  return {
    outcome: result.outcome,
    settings,
    error:
      project?.state === "error"
        ? (project.errorMessage ?? project.errorReason ?? "unknown error")
        : null,
  };
}

/** Prints what `add` and `work` did once the worker took the project. */
export function reportAddedProject(
  instance: string,
  result: AddProjectResult,
  reporter: Pick<BaseReporter, "warn">,
): void {
  writeText(addedProjectLines(instance, result));
  if (result.error !== null) {
    reporter.warn(
      `${result.settings.projectRef} could not start yet: ${result.error}. The worker retries it on its own.`,
    );
  }
}

export function addedProjectLines(
  instance: string,
  result: AddProjectResult,
): string[] {
  const { projectRef, repoDir } = result.settings;
  const summary = {
    added: `Added ${projectRef} (${repoDir}) to worker instance ${instance}.`,
    updated: `Updated ${projectRef}'s settings on worker instance ${instance}.`,
    restarting: `${projectRef} restarts on worker instance ${instance} with the new settings once its current runs finish.`,
    removed: `${projectRef} was removed from worker instance ${instance} while it was being added.`,
  }[result.outcome];
  return [
    summary,
    nextHint(`${instance} worker status`),
    nextHint(`${instance} worker logs ${projectRef} -f`),
  ];
}

export async function runWorkerAdd(
  arguments_: AddProjectArguments,
  deps: WorkerAddDeps = {},
): Promise<void> {
  await withReporter("worker-add-command", async ({ reporter }) => {
    const instance = resolveWorkerInstance();
    const worker = await requireRunningWorker(
      instance,
      { checkVersion: true },
      deps,
    );
    const settings = await resolveProjectSettings(arguments_, deps);
    const result = await addProjectToWorker(instance, worker, settings);
    reportAddedProject(instance, result, reporter);
  });
}

/** `[project]`, `-c`, `-k`, `--work-item-id` and `--base-url`, shared with `scarn work`. */
export const withAddProjectOptions = <T>(argv: Argv<T>) =>
  argv
    .positional("project", {
      describe:
        'The project to work on, as owner/slug (defaults to "project" in .scarn/scarn.jsonc)',
      type: "string",
    })
    .option("baseUrl", {
      alias: "base-url",
      describe: "Scarn API URL",
      type: "string",
    })
    .option("concurrency", {
      alias: "c",
      describe:
        "Maximum number of this project's runs at a time (within the worker's --max-concurrency)",
      type: "number",
    })
    .option("preserveRuntimeOnComplete", {
      alias: ["k", "preserve-runtime-on-complete"],
      describe:
        "Keep runtime containers and workspace after each run (with " +
        "`work --dry-run`, after the health report)",
      type: "boolean",
      default: false,
    })
    .option("workItemId", {
      alias: "work-item-id",
      describe: "Only process tasks for this work item ID",
      type: "string",
    });

export function createWorkerAddCommand(
  deps: WorkerAddDeps = {},
): CommandModule<object, AddProjectArguments> {
  return {
    command: "add [project]",
    describe:
      "Add the project in this checkout to the background worker, or update its settings",
    builder: (argv: Argv<object>) => withAddProjectOptions(argv),
    handler: (arguments_: ArgumentsCamelCase<AddProjectArguments>) =>
      runWorkerAdd(arguments_, deps),
  };
}

export const workerAddCommand = createWorkerAddCommand();
