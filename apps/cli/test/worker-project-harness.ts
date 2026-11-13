/**
 * A real control server backed by a recording fake supervisor, for the
 * `scarn worker add|remove|cancel` and `scarn work` tests, plus the fixed
 * checkout those commands resolve.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import {
  CONTROL_API_PROTOCOL,
  startControlServer,
  writeWorkerDiscovery,
  type AddOrUpdateProjectResult,
  type ControlServer,
  type ControlSupervisor,
  type ProjectSettingsInput,
  type ProjectWorkerStatus,
  type RemoveProjectResult,
  type WorkerStatus,
} from "@scarn/worker";
import type {
  AddProjectArguments,
  ProjectSettingsDeps,
} from "../src/commands/worker/add";
import { resolveWorkerVersion } from "../src/lib/worker-version";
import { FAKE_PROJECT_ID } from "./worker-host-fakes";

export const INSTANCE = "test-worker-project-commands";
export const BASE_URL = "https://scarn.test";

export function settingsFor(baseUrl: string): ProjectSettingsInput {
  return {
    projectId: FAKE_PROJECT_ID,
    projectRef: "acme/app",
    repoDir: "/repos/app",
    sourceBranch: "main",
    baseUrl,
    addedByUserId: "user-1",
    concurrency: 2,
    workItemId: null,
    preserveRuntime: false,
  };
}

export function projectStatus(): ProjectWorkerStatus {
  return {
    projectId: FAKE_PROJECT_ID,
    projectRef: "acme/app",
    state: "running",
    errorReason: null,
    errorMessage: null,
    nextRetryAt: null,
    settings: {
      ...settingsFor(BASE_URL),
      instance: INSTANCE,
      createdAt: "2026-11-12T00:00:00.000Z",
      updatedAt: "2026-11-12T00:00:00.000Z",
    },
    activeRuns: 0,
  };
}

/** Records adds, and appends removes and aborts to the shared `events`. */
export class FakeSupervisor implements ControlSupervisor {
  readonly added: ProjectSettingsInput[] = [];
  state: ControlSupervisor["state"] = "running";
  readonly instance = INSTANCE;
  addResult: AddOrUpdateProjectResult = { outcome: "added", project: null };
  removeResult: RemoveProjectResult = { removed: true, drainingRuns: [] };
  runFound = true;
  projects: ProjectWorkerStatus[] = [projectStatus()];

  constructor(readonly events: string[]) {}

  addOrUpdateProject(input: ProjectSettingsInput) {
    this.added.push(input);
    return Promise.resolve(this.addResult);
  }

  removeProject(projectId: string) {
    this.events.push(`remove ${projectId}`);
    return this.removeResult;
  }

  setMachineLimit(limit: number) {
    return { maxConcurrency: limit };
  }

  cancelRun(taskRunId: string) {
    this.events.push(`abort ${taskRunId}`);
    return { found: this.runFound };
  }

  stop() {
    return Promise.resolve();
  }

  status(): WorkerStatus {
    return {
      instance: INSTANCE,
      baseUrl: BASE_URL,
      state: this.state,
      maxConcurrency: 4,
      slots: { machineLimit: 4, machineInUse: 0, projects: [] },
      projects: this.projects,
      activeRuns: [],
      recentRuns: [],
    };
  }
}

const noSlots = {
  acquire: () => 0,
  release: () => undefined,
  changed: () => new Promise<void>(() => undefined),
};

export type WorkerProjectHarness = {
  readonly supervisor: FakeSupervisor;
  readonly events: string[];
  startWorker(version?: string): void;
};

/**
 * Registers hooks giving each test a fresh home, instance, supervisor and
 * event list; `startWorker` serves the supervisor and writes its discovery.
 */
export function useWorkerProjectHarness(): WorkerProjectHarness {
  let home = "";
  let events: string[] = [];
  let supervisor = new FakeSupervisor(events);
  let server: ControlServer | undefined;
  let previousInstance: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "scarn-worker-projects-"));
    setHomeDirForTests(home);
    previousInstance = process.env["SCARN_WORKER_INSTANCE"];
    process.env["SCARN_WORKER_INSTANCE"] = INSTANCE;
    events = [];
    supervisor = new FakeSupervisor(events);
    server = undefined;
  });

  afterEach(async () => {
    await server?.close({ force: true });
    if (previousInstance === undefined) {
      delete process.env["SCARN_WORKER_INSTANCE"];
    } else {
      process.env["SCARN_WORKER_INSTANCE"] = previousInstance;
    }
    setHomeDirForTests(undefined);
    rmSync(home, { recursive: true, force: true });
  });

  return {
    get supervisor() {
      return supervisor;
    },
    get events() {
      return events;
    },
    startWorker(version: string = resolveWorkerVersion()) {
      const started = startControlServer({
        supervisor,
        slots: noSlots,
        version,
        pid: process.pid,
        startedAt: "2026-11-12T00:00:00.000Z",
        logFilePath: path.join(home, "unused.log"),
      });
      writeWorkerDiscovery({
        pid: process.pid,
        port: started.port,
        token: started.token,
        version,
        protocol: CONTROL_API_PROTOCOL,
        instance: INSTANCE,
        baseUrl: BASE_URL,
        startedAt: "2026-11-12T00:00:00.000Z",
      });
      server = started;
    },
  };
}

/** Everything written to stdout and stderr (where the reporter writes) while `fn` runs. */
export async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const capture = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    await fn();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return chunks.join("");
}

/** A checkout of acme/app at /repos/app on `main`, signed in as user-1. */
export function projectDeps(baseUrl: string = BASE_URL): ProjectSettingsDeps {
  return {
    findGitRoot: () => Promise.resolve("/repos/app"),
    resolveTarget: () =>
      Promise.resolve({
        baseUrl,
        projectRef: "acme/app",
        projectId: FAKE_PROJECT_ID,
        repoDir: "/repos/app",
        sourceBranch: "main",
        sourceBranchWarning: undefined,
      }),
    resolveUserId: () => Promise.resolve("user-1"),
  };
}

export const addArguments: AddProjectArguments = {
  project: "acme/app",
  baseUrl: undefined,
  concurrency: 2,
  preserveRuntimeOnComplete: false,
  workItemId: undefined,
  sourceBranch: undefined,
};
