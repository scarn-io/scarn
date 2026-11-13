/**
 * `scarn worker start --foreground --once <project>`: one pass of one
 * project loop from the current checkout, the way `scarn work --once` runs.
 * It claims once, waits for every claimed run to settle and returns. Nothing
 * is saved and no control server is started.
 *
 * When a background worker for the instance is running (same version and
 * protocol), the loop borrows its run slots over `/slots/*`, so the pass
 * stays within the machine limit; otherwise it gets a private allocator of
 * `concurrency` slots.
 */
import {
  CONTROL_API_PROTOCOL,
  RemoteSlotPort,
  findRunningWorker,
  readLocalEnvVars,
  runProjectWork,
  type ProcessProjectWorkDeps,
  type ProcessProjectWorkOptions,
  type ProcessProjectWorkResult,
  type RunningWorker,
  type SlotPort,
  type WorkReporter,
} from "@scarn/worker";
import type { Logger } from "../../lib/logger";
import { resolveWorkerVersion } from "../../lib/worker-version";
import {
  resolveWorkTarget,
  type ResolveWorkTargetInput,
  type WorkTarget,
} from "../../lib/resolve-work-target";
import { assertPositiveInteger } from "./instance-settings";

export type RunOnceOptions = {
  instance: string;
  project?: string | undefined;
  baseUrl?: string | undefined;
  concurrency?: number | undefined;
  preserveRuntimeOnComplete: boolean;
  workItemId?: string | undefined;
  sourceBranch?: string | undefined;
};

export type RunOnceDeps = {
  reporter: WorkReporter;
  logger: Logger;
  version?: string | undefined;
  resolveTarget?:
    ((input: ResolveWorkTargetInput) => Promise<WorkTarget>) | undefined;
  findRunningWorker?:
    ((instance: string) => Promise<RunningWorker | null>) | undefined;
  readLocalEnv?:
    ((repoDir: string) => Promise<Record<string, string>>) | undefined;
  runProjectWork?:
    | ((
        options: ProcessProjectWorkOptions,
        deps?: ProcessProjectWorkDeps,
      ) => Promise<ProcessProjectWorkResult>)
    | undefined;
  dest?: ProcessProjectWorkOptions["dest"];
};

export async function runWorkerOnce(
  options: RunOnceOptions,
  deps: RunOnceDeps,
): Promise<ProcessProjectWorkResult> {
  assertPositiveInteger(options.concurrency, "--concurrency");
  const { reporter, logger } = deps;
  const target = await (deps.resolveTarget ?? resolveWorkTarget)({
    project: options.project,
    baseUrl: options.baseUrl,
    sourceBranch: options.sourceBranch,
  });
  if (target.sourceBranchWarning) {
    reporter.warn(target.sourceBranchWarning);
    logger.warn({ branch: target.sourceBranch }, target.sourceBranchWarning);
  }
  if (target.sourceBranch) {
    reporter.info(`Using source branch: ${target.sourceBranch}`);
  }

  const borrowed = await borrowWorkerSlots(options.instance, deps);
  const readLocalEnv = deps.readLocalEnv ?? readLocalEnvVars;
  try {
    const result = await (deps.runProjectWork ?? runProjectWork)({
      projectId: target.projectId,
      baseUrl: target.baseUrl,
      concurrency: options.concurrency,
      preserveRuntimeOnComplete: options.preserveRuntimeOnComplete,
      once: true,
      workItemId: options.workItemId,
      sourceBranch: target.sourceBranch,
      readLocalEnv: () => readLocalEnv(target.repoDir),
      slots: borrowed,
      reporter,
      dest: deps.dest,
    });
    logger.info(
      { projectId: target.projectId, ...result },
      "Single-pass work result",
    );
    return result;
  } finally {
    await borrowed?.close();
  }
}

async function borrowWorkerSlots(
  instance: string,
  deps: RunOnceDeps,
): Promise<(SlotPort & { close(): Promise<void> }) | undefined> {
  let running: RunningWorker | null;
  try {
    running = await (deps.findRunningWorker ?? findRunningWorker)(instance);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.reporter.warn(`${message} Using local slots instead.`);
    deps.logger.warn({ err: error }, "Could not reach the background worker");
    return undefined;
  }
  if (!running) return undefined;
  const version = deps.version ?? resolveWorkerVersion();
  if (
    running.health.version !== version ||
    running.health.protocol !== CONTROL_API_PROTOCOL
  ) {
    deps.reporter.warn(
      `The background worker for ${instance} runs version ${running.health.version}, ` +
        `not ${version}; using local slots instead of sharing its limit.`,
    );
    return undefined;
  }
  deps.reporter.info(
    `Sharing run slots with the background worker (pid ${String(running.discovery.pid)}).`,
  );
  return new RemoteSlotPort({ client: running.client });
}
