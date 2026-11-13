/**
 * `scarn work [project]`: a shortcut for `scarn worker start` followed by
 * `scarn worker add`. It starts the instance's background worker when none
 * runs, adds the project in the current checkout, prints where to follow it,
 * and returns right away.
 *
 * `scarn work --dry-run` still rehearses a task's environment in this
 * process; see `./work-dry-run`.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import { resolveWorkerInstance } from "@scarn/worker";
import { withReporter } from "../lib/command-output";
import {
  addProjectToWorker,
  reportAddedProject,
  resolveProjectSettings,
  withAddProjectOptions,
  type AddProjectArguments,
  type ProjectSettingsDeps,
} from "./worker/add";
import {
  ensureWorkerRunning,
  type EnsureWorkerRunningDeps,
} from "./worker/background-start";
import {
  assertWorkerVersion,
  type ConnectToWorkerDeps,
} from "./worker/connect";
import { runWorkDryRun } from "./work-dry-run";

export type WorkArguments = AddProjectArguments & {
  dryRun: boolean;
  stepId: string | undefined;
  globalOnly: boolean;
  pipelineId: string | undefined;
};

export type WorkShortcutDeps = ProjectSettingsDeps &
  EnsureWorkerRunningDeps &
  Pick<ConnectToWorkerDeps, "version" | "protocol">;

/** Starts the background worker when needed, then adds the project to it. */
export async function runWorkShortcut(
  arguments_: AddProjectArguments,
  deps: WorkShortcutDeps = {},
): Promise<void> {
  await withReporter("work-command", async ({ reporter }) => {
    const instance = resolveWorkerInstance();
    const settings = await resolveProjectSettings(arguments_, reporter, deps);
    const { started, worker } = await ensureWorkerRunning(
      { instance, baseUrl: settings.baseUrl },
      deps,
    );
    assertWorkerVersion(instance, worker, deps);
    reporter.info(
      started
        ? `Started worker instance ${instance} (pid ${String(worker.discovery.pid)}).`
        : `Worker instance ${instance} is already running (pid ${String(worker.discovery.pid)}).`,
    );
    const result = await addProjectToWorker(instance, worker, settings);
    reportAddedProject(instance, result, reporter);
  });
}

const withDryRunOptions = <T>(argv: Argv<T>) =>
  argv
    .option("dryRun", {
      alias: "dry-run",
      describe:
        "Rehearse the environment a real task would launch (devcontainer + " +
        "OpenCode + MCP servers) and report its health instead of running work",
      type: "boolean",
      default: false,
    })
    .option("stepId", {
      alias: "step-id",
      describe:
        "Dry run only: fetch this step definition's real MCP servers to test",
      type: "string",
    })
    .option("globalOnly", {
      alias: "global-only",
      describe:
        "Dry run only: skip step-specific MCP injection and test whatever " +
        "is already configured",
      type: "boolean",
      default: false,
    })
    .option("pipelineId", {
      alias: "pipeline-id",
      describe:
        "Dry run only: resolve this pipeline definition ID to its first " +
        "step and test that (wins over --step-id/--global-only)",
      type: "string",
    });

export function createWorkCommand(
  deps: WorkShortcutDeps = {},
): CommandModule<object, WorkArguments> {
  return {
    command: "work [project]",
    describe:
      "Start the background worker if needed and add this checkout's project to it",
    builder: (argv: Argv<object>) =>
      withDryRunOptions(withAddProjectOptions(argv)),
    handler: (arguments_: ArgumentsCamelCase<WorkArguments>) =>
      arguments_.dryRun
        ? runWorkDryRun(arguments_)
        : runWorkShortcut(arguments_, deps),
  };
}

export const workCommand = createWorkCommand();
