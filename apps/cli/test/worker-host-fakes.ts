/**
 * Fakes for hosting a foreground worker without a server or runtime: project
 * workers that each hold one run until it is aborted, and host deps that are
 * never asked to do real work.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  SqliteWorkerSettingsStore,
  workerDiscoveryFilePath,
  type CreateProjectWorker,
  type ProjectWorkerDeps,
  type WorkerDiscovery,
} from "@scarn/worker";

export const FAKE_PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";

const noop = () => undefined;

export const fakeHostDeps = {
  createWorkerClient: () =>
    Promise.reject(new Error("fake host deps make no API calls")),
  createRunTracker: () => {
    throw new Error("fake host deps track no runs");
  },
  runtimeEnvironmentOrchestrator: {
    launch: () => Promise.reject(new Error("fake host deps launch nothing")),
  },
  agentRunner: {
    promptAsync: () => Promise.reject(new Error("unused")),
    getSessionStatus: () => Promise.reject(new Error("unused")),
    abort: () => Promise.resolve(undefined),
    sendRetryPrompt: () => Promise.reject(new Error("unused")),
  },
  sleep: () => Promise.resolve(),
  logger: { debug: noop, log: noop, error: noop },
} as unknown as ProjectWorkerDeps["hostDeps"];

/**
 * Project workers that start one run each, which only ends when the run is
 * aborted (a forced stop). `print` hears `run started`, `project draining`
 * and `run ended: <reason>`.
 */
export function createHoldingProjectWorkers(
  print: (line: string) => void,
): CreateProjectWorker {
  return (settings, deps) => {
    let job: Promise<void> = Promise.resolve();
    let state: "running" | "draining" | "stopped" = "stopped";
    return {
      projectId: settings.projectId,
      settings,
      start: () => {
        state = "running";
        job = deps.runRegistry.start(
          {
            taskRunId: `run-${settings.projectId}`,
            projectId: settings.projectId,
          },
          (handle) =>
            new Promise<void>((resolve) => {
              print("run started");
              handle.signal.addEventListener(
                "abort",
                () => {
                  print(`run ended: ${String(handle.abortReason())}`);
                  resolve();
                },
                { once: true },
              );
            }),
        );
        return Promise.resolve();
      },
      updateSettings: () => "applied",
      drain: async () => {
        state = "draining";
        print("project draining");
        await job;
        state = "stopped";
      },
      status: () => ({
        projectId: settings.projectId,
        projectRef: settings.projectRef,
        state,
        errorReason: null,
        errorMessage: null,
        nextRetryAt: null,
        settings,
        activeRuns: deps.runRegistry.count({ projectId: settings.projectId }),
      }),
    };
  };
}

export function saveFakeProject(databasePath: string, instance: string): void {
  const store = new SqliteWorkerSettingsStore({ databasePath });
  try {
    store.upsertProject({
      instance,
      projectId: FAKE_PROJECT_ID,
      projectRef: "acme/app",
      repoDir: "/repos/app",
      sourceBranch: "main",
      baseUrl: "http://scarn.test",
      addedByUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe002",
      concurrency: null,
      workItemId: null,
      preserveRuntime: false,
    });
  } finally {
    store.close();
  }
}

export function readDiscoveryFile(instance: string): WorkerDiscovery | null {
  const filePath = workerDiscoveryFilePath(instance);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as WorkerDiscovery;
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
