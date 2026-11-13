/**
 * How `scarn pipelines design` hands its queued run to the instance's
 * background worker instead of running a worker in this terminal.
 *
 * It starts the worker when none runs and adds the project when the worker
 * does not have it yet, with no work-item filter. A project already added
 * keeps its settings: when they filter to another work item, the run just
 * queued will not be picked up, and the user is told how to fix that.
 */
import { resolveWorkerInstance, type RunningWorker } from "@scarn/worker";
import {
  addProjectToWorker,
  resolveProjectSettings,
  type ProjectSettingsDeps,
} from "../commands/worker/add";
import {
  ensureWorkerRunning,
  type EnsureWorkerRunningDeps,
} from "../commands/worker/background-start";
import {
  assertWorkerVersion,
  controlData,
  type ConnectToWorkerDeps,
} from "../commands/worker/connect";
import type { DesignRunTarget } from "./design-run-offer";
import type { BaseReporter } from "./reporter-types";

export type DesignWorkerHandOffInput = {
  target: DesignRunTarget;
  baseUrl: string;
  /** The checkout the design session ran in; the project is added from it. */
  projectRoot: string;
  reporter: Pick<BaseReporter, "info" | "warn">;
};

export type DesignWorkerHandOffDeps = Omit<ProjectSettingsDeps, "cwd"> &
  EnsureWorkerRunningDeps &
  Pick<ConnectToWorkerDeps, "version" | "protocol"> & {
    instance?: string | undefined;
  };

export function queuedMessage(instance: string): string {
  return `Queued — your worker will pick this up. Follow it with \`${instance} worker status\`.`;
}

export function workItemFilterWarning(input: {
  instance: string;
  projectRef: string;
  savedWorkItemId: string;
  designWorkItemId: string;
}): string {
  const { instance, projectRef, savedWorkItemId, designWorkItemId } = input;
  return (
    `${projectRef} is on worker instance ${instance} with --work-item-id ` +
    `${savedWorkItemId}, so it will not pick up this run of work item ` +
    `${designWorkItemId}. Run \`${instance} worker add ${projectRef}\` from ` +
    `this checkout to drop the filter, or add --work-item-id ` +
    `${designWorkItemId} to work on this item only.`
  );
}

async function savedWorkItemFilter(
  worker: RunningWorker,
  projectId: string,
): Promise<{ added: false } | { added: true; workItemId: string | null }> {
  const status = await controlData(
    "read the worker's status",
    worker.client.status.get({ query: {} }),
  );
  const project = status.projects.find((p) => p.projectId === projectId);
  return project
    ? { added: true, workItemId: project.settings.workItemId }
    : { added: false };
}

/** Starts the worker if needed, adds the project if needed, and says where to follow the run. */
export async function handOffToWorker(
  input: DesignWorkerHandOffInput,
  deps: DesignWorkerHandOffDeps = {},
): Promise<void> {
  const { target, baseUrl, projectRoot, reporter } = input;
  const instance = deps.instance ?? resolveWorkerInstance();
  const { started, worker } = await ensureWorkerRunning(
    { instance, baseUrl },
    deps,
  );
  assertWorkerVersion(instance, worker, deps);
  if (started) {
    reporter.info(
      `Started worker instance ${instance} (pid ${String(worker.discovery.pid)}).`,
    );
  }

  const saved = await savedWorkItemFilter(worker, target.projectId);
  if (!saved.added) {
    const settings = await resolveProjectSettings(
      {
        project: target.project,
        baseUrl,
        concurrency: undefined,
        preserveRuntimeOnComplete: false,
        workItemId: undefined,
        sourceBranch: undefined,
      },
      reporter,
      { ...deps, cwd: projectRoot },
    );
    const result = await addProjectToWorker(instance, worker, settings);
    reporter.info(
      `Added ${settings.projectRef} (${settings.repoDir} @ ${settings.sourceBranch}) to worker instance ${instance}.`,
    );
    if (result.error !== null) {
      reporter.warn(
        `${settings.projectRef} could not start yet: ${result.error}. The worker retries it on its own.`,
      );
    }
  } else if (
    saved.workItemId !== null &&
    saved.workItemId !== target.workItemId
  ) {
    reporter.warn(
      workItemFilterWarning({
        instance,
        projectRef: target.project,
        savedWorkItemId: saved.workItemId,
        designWorkItemId: target.workItemId,
      }),
    );
  }

  reporter.info(queuedMessage(instance));
}
