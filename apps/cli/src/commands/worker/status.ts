/**
 * `scarn worker status [--json]`: the instance's worker, its limits, each
 * project with its state, the active runs and the recent runs. When no
 * worker runs it fails with "not running" and exit code 3.
 */
import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs";
import {
  resolveWorkerInstance,
  type WorkerHealth,
  type WorkerStatus,
} from "@scarn/worker";
import { withReporter } from "../../lib/command-output";
import { writeJson, writeText } from "../../lib/output";
import {
  controlData,
  requireRunningWorker,
  type ConnectToWorkerDeps,
} from "./connect";

export type WorkerStatusArguments = {
  json: boolean;
  recentRuns: number | undefined;
};

export async function runWorkerStatus(
  arguments_: WorkerStatusArguments,
  deps: ConnectToWorkerDeps = {},
): Promise<void> {
  await withReporter("worker-status-command", async () => {
    const instance = resolveWorkerInstance();
    const worker = await requireRunningWorker(
      instance,
      { checkVersion: true },
      deps,
    );
    const status = await controlData(
      "read the worker's status",
      worker.client.status.get({
        query:
          arguments_.recentRuns === undefined
            ? {}
            : { recentRuns: arguments_.recentRuns },
      }),
    );
    if (arguments_.json) writeJson({ health: worker.health, status });
    else writeText(formatWorkerStatus(worker.health, status));
  });
}

export function formatWorkerStatus(
  health: WorkerHealth,
  status: WorkerStatus,
): string[] {
  const refs = new Map(status.projects.map((p) => [p.projectId, p.projectRef]));
  const projectName = (projectId: string) => refs.get(projectId) ?? projectId;
  const lines = [
    `Worker ${status.instance}: ${status.state}`,
    `  version ${health.version}, pid ${String(health.pid)}, started ${health.startedAt}`,
    `  server ${status.baseUrl ?? "(not bound)"}`,
    `  slots ${String(status.slots.machineInUse)}/${String(status.slots.machineLimit)} in use (max concurrency ${String(status.maxConcurrency)})`,
    "",
    "Projects:",
  ];
  if (status.projects.length === 0) lines.push("  (none)");
  for (const project of status.projects) {
    const slot = status.slots.projects.find(
      (p) => p.projectId === project.projectId,
    );
    const limit = slot?.limit ?? project.settings.concurrency;
    const error =
      project.state === "error" && project.errorReason
        ? ` (${project.errorReason}${project.errorMessage ? `: ${project.errorMessage}` : ""}${project.nextRetryAt ? `; retry at ${project.nextRetryAt}` : ""})`
        : "";
    lines.push(
      `  ${project.projectRef}  ${project.state}${error}  runs ${String(project.activeRuns)}/${limit === null ? "-" : String(limit)}  ${project.settings.repoDir} @ ${project.settings.sourceBranch}`,
    );
  }
  lines.push("", "Active runs:");
  if (status.activeRuns.length === 0) lines.push("  (none)");
  for (const run of status.activeRuns) {
    lines.push(
      `  ${run.taskRunId}  ${projectName(run.projectId)}  ${run.taskName ?? "-"}  ${run.phase}  since ${run.startedAt}`,
    );
  }
  lines.push("", "Recent runs:");
  if (status.recentRuns.length === 0) lines.push("  (none)");
  for (const run of status.recentRuns) {
    const reason = run.failureReason ? `  ${run.failureReason}` : "";
    lines.push(
      `  ${run.taskRunId}  ${projectName(run.projectId)}  ${run.status}  ${run.completedAt ?? run.updatedAt}${reason}`,
    );
  }
  return lines;
}

export function createWorkerStatusCommand(
  deps: ConnectToWorkerDeps = {},
): CommandModule<object, WorkerStatusArguments> {
  return {
    command: "status",
    describe: "Show this machine's background worker, its projects and runs",
    builder: (argv: Argv<object>) =>
      argv
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Print the worker's health and status as one JSON document",
        })
        .option("recentRuns", {
          alias: "recent-runs",
          type: "number",
          describe: "How many recent runs to show (default 20)",
        }),
    handler: (arguments_: ArgumentsCamelCase<WorkerStatusArguments>) =>
      runWorkerStatus(arguments_, deps),
  };
}

export const workerStatusCommand = createWorkerStatusCommand();
