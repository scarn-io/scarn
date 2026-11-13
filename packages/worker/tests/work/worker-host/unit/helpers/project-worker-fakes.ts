/**
 * Fakes for driving real project workers without a server or runtime: a
 * worker client that hands out as many claims as asked, a runtime whose
 * launches block until released, injected retry timers and auth watchers.
 */
import { vi } from "bun:test";
import { parseUuidV7 } from "../../../../../src/common/contracts/uuid-v7";
import type { ProjectWorkHostDeps } from "../../../../../src/work/task-run/application/project-work-setup";
import type {
  TaskRunWorkerClaim,
  TaskRunWorkerClient,
} from "../../../../../src/work/task-run/contracts/process-project-work-types";
import type { WorkerProjectSettings } from "../../../../../src/work/worker-host/contracts/worker-settings";
import type { ProjectWorkerTimer } from "../../../../../src/work/worker-host/application/project-worker";
import {
  createRunTracker,
  createWorkerClient,
  projectId,
} from "../../../task-run/unit/helpers/claimed-task-fixtures";

export const NOW = new Date("2026-11-12T10:00:00.000Z");

export function tick(milliseconds = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
    await tick(5);
  }
  if (!condition()) throw new Error("Condition never became true");
}

export function createSettings(
  overrides: Partial<WorkerProjectSettings> = {},
): WorkerProjectSettings {
  return {
    instance: "scarn",
    projectId,
    projectRef: "acme/app",
    repoDir: "/repos/app",
    sourceBranch: "main",
    baseUrl: "http://scarn.test",
    addedByUserId: "01966a2c-9494-7db5-aa46-0f8f5cbbe002",
    concurrency: null,
    workItemId: null,
    preserveRuntime: false,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

export function createFakeTimers() {
  const pending: { callback: () => void; milliseconds: number }[] = [];
  const schedule: ProjectWorkerTimer = (callback, milliseconds) => {
    const entry = { callback, milliseconds };
    pending.push(entry);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  return {
    schedule,
    pending,
    fireNext() {
      const entry = pending.shift();
      if (!entry) throw new Error("No retry timer pending");
      entry.callback();
    },
  };
}

export function createClaimSource() {
  let issued = 0;
  return vi.fn((request: { batchSize: number; workItemId?: string }) => {
    const claims: TaskRunWorkerClaim[] = [];
    for (let index = 0; index < request.batchSize; index += 1) {
      issued += 1;
      claims.push({
        task: {
          id: parseUuidV7(
            `01966a2c-9494-7db5-aa46-${issued.toString(16).padStart(12, "0")}`,
          ),
        },
        claimToken: `claim-${String(issued)}`,
      });
    }
    return Promise.resolve(claims);
  });
}

/**
 * Host deps whose runtime launches block until `releaseRuns()`, then fail,
 * so each claimed run stays in the run registry until released.
 */
export function createFakeHostDeps() {
  let releaseRuns!: () => void;
  const runsReleased = new Promise<void>((resolve) => {
    releaseRuns = resolve;
  });
  const workerClient = {
    ...createWorkerClient(),
    claimTaskRuns: createClaimSource(),
    getTaskRun: vi.fn(() => Promise.resolve({ status: "running" as const })),
    failTaskRun: vi.fn(() => Promise.resolve(undefined)),
  };
  const launch = vi.fn(async () => {
    await runsReleased;
    throw new Error("launch finished");
  });
  const createWorkerClientFn = vi.fn((): Promise<TaskRunWorkerClient> =>
    Promise.resolve(workerClient),
  );
  const hostDeps: ProjectWorkHostDeps = {
    createWorkerClient: createWorkerClientFn,
    createRunTracker,
    runtimeEnvironmentOrchestrator: { launch },
    agentRunner: {
      promptAsync: vi.fn(),
      getSessionStatus: vi.fn(),
      abort: vi.fn(() => Promise.resolve(undefined)),
      sendRetryPrompt: vi.fn(),
    },
    artifactStore: { saveArtifact: vi.fn() },
    sleep: () => tick(),
    logger: { debug: vi.fn(), log: vi.fn(), error: vi.fn() },
  };
  return {
    hostDeps,
    workerClient,
    createWorkerClient: createWorkerClientFn,
    launch,
    releaseRuns,
  };
}

export function createFakeAuthWatcher() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    watchAuthFile: (onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}
