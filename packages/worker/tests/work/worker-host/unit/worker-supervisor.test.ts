/**
 * The background worker runs one project worker per saved project, sharing
 * one slot allocator and run registry: it restores saved projects, changes
 * limits in place, lets removed projects' runs finish, and stops gently or
 * by force.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerAuthError } from "../../../../src/auth/session/domain/worker-auth-error";
import { WORKER_STOPPED_ERROR_CODE } from "../../../../src/work/task-run/application/worker-stopped-error";
import {
  WorkerSupervisor,
  type ProjectSettingsInput,
} from "../../../../src/work/worker-host/application/worker-supervisor";
import {
  WorkerBaseUrlMismatchError,
  WorkerNotRunningError,
} from "../../../../src/work/worker-host/domain/worker-supervisor-errors";
import { SqliteWorkerSettingsStore } from "../../../../src/work/worker-host/infra/sqlite-worker-settings-store";
import { captureRejection } from "../../../support/capture-rejection";
import { projectId } from "../../task-run/unit/helpers/claimed-task-fixtures";
import {
  createFakeAuthWatcher,
  createFakeHostDeps,
  createFakeTimers,
  createSettings,
  NOW,
  tick,
  waitUntil,
} from "./helpers/project-worker-fakes";

const otherProjectId = "01966a2c-9494-7db5-aa46-0f8f5cbbe0aa";

function projectInput(
  overrides: Partial<ProjectSettingsInput> = {},
): ProjectSettingsInput {
  const { instance, createdAt, updatedAt, ...settings } = createSettings();
  void instance;
  void createdAt;
  void updatedAt;
  return { ...settings, ...overrides };
}

let dir: string;
let store: SqliteWorkerSettingsStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "scarn-worker-supervisor-"));
  store = new SqliteWorkerSettingsStore({
    databasePath: path.join(dir, "db.sqlite"),
    now: () => NOW,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function createHarness(options: { missingRepos?: string[] } = {}) {
  const fake = createFakeHostDeps();
  const fakeTimers = createFakeTimers();
  const auth = createFakeAuthWatcher();
  const missingRepos = new Set(options.missingRepos ?? []);
  const supervisor = new WorkerSupervisor({
    instance: "scarn",
    store,
    defaultMaxConcurrency: 4,
    projectWorkerDeps: {
      hostDeps: fake.hostDeps,
      hostname: () => "box",
      repoExists: (repoDir) => Promise.resolve(!missingRepos.has(repoDir)),
      watchAuthFile: auth.watchAuthFile,
      schedule: fakeTimers.schedule,
      now: () => NOW,
      loopOptions: { pollIntervalMs: 1 },
    },
  });
  const activeRuns = (id?: string) =>
    supervisor.status().activeRuns.filter((run) => !id || run.projectId === id)
      .length;
  const project = (id: string) =>
    supervisor.status().projects.find((entry) => entry.projectId === id);
  return {
    ...fake,
    supervisor,
    fakeTimers,
    auth,
    missingRepos,
    activeRuns,
    project,
    async finish() {
      fake.releaseRuns();
      await supervisor.stop();
    },
  };
}

function saveProject(overrides: Partial<ProjectSettingsInput> = {}): void {
  store.upsertProject({ ...projectInput(overrides), instance: "scarn" });
}

describe("WorkerSupervisor", () => {
  test("restores saved projects; a missing repo directory leaves only that project in error", async () => {
    saveProject({ concurrency: 1 });
    saveProject({
      projectId: otherProjectId,
      repoDir: "/repos/gone",
      concurrency: 1,
    });
    const harness = createHarness({ missingRepos: ["/repos/gone"] });

    await harness.supervisor.start();
    await waitUntil(() => harness.activeRuns(projectId) === 1);

    expect(harness.supervisor.state).toBe("running");
    expect(harness.project(projectId)?.state).toBe("running");
    expect(harness.project(otherProjectId)).toMatchObject({
      state: "error",
      errorReason: "repo_missing",
    });
    expect(store.getProject("scarn", otherProjectId)).not.toBeNull();
    await harness.finish();
    expect(harness.supervisor.state).toBe("stopped");
  });

  test("applies the saved machine limit on start, and saves a new one", async () => {
    store.saveInstance({
      instance: "scarn",
      baseUrl: "http://scarn.test",
      maxConcurrency: 2,
    });
    const harness = createHarness();

    await harness.supervisor.start();
    expect(harness.supervisor.status().maxConcurrency).toBe(2);

    expect(harness.supervisor.setMachineLimit(6)).toEqual({
      maxConcurrency: 6,
    });
    expect(harness.supervisor.status().slots.machineLimit).toBe(6);
    expect(store.getInstance("scarn")?.maxConcurrency).toBe(6);
    await harness.finish();
  });

  test("adds a project and binds the instance to its server", async () => {
    const harness = createHarness();
    await harness.supervisor.start();

    const result = await harness.supervisor.addOrUpdateProject(
      projectInput({ concurrency: 1 }),
    );
    await waitUntil(() => harness.activeRuns() === 1);

    expect(result).toMatchObject({
      outcome: "added",
      project: { projectId, state: "running" },
    });
    expect(store.getInstance("scarn")).toMatchObject({
      baseUrl: "http://scarn.test",
      maxConcurrency: 4,
    });
    expect(
      await captureRejection(
        harness.supervisor.addOrUpdateProject(
          projectInput({
            projectId: otherProjectId,
            baseUrl: "http://elsewhere.test",
          }),
        ),
      ),
    ).toBeInstanceOf(WorkerBaseUrlMismatchError);
    expect(store.getProject("scarn", otherProjectId)).toBeNull();
    await harness.finish();
  });

  test("changes a project's limit without a restart", async () => {
    saveProject({ concurrency: 1 });
    const harness = createHarness();
    await harness.supervisor.start();
    await waitUntil(() => harness.activeRuns() === 1);
    await tick(20);
    expect(harness.activeRuns()).toBe(1);

    const result = await harness.supervisor.addOrUpdateProject(
      projectInput({ concurrency: 3 }),
    );
    await waitUntil(() => harness.activeRuns() === 3);

    expect(result.outcome).toBe("updated");
    expect(harness.createWorkerClient).toHaveBeenCalledTimes(1);
    expect(store.getProject("scarn", projectId)?.concurrency).toBe(3);
    await harness.finish();
  });

  test("drains the old project worker before starting one for a new repo directory", async () => {
    saveProject({ concurrency: 1 });
    const harness = createHarness();
    await harness.supervisor.start();
    await waitUntil(() => harness.activeRuns() === 1);

    const result = await harness.supervisor.addOrUpdateProject(
      projectInput({ concurrency: 1, repoDir: "/repos/moved" }),
    );

    expect(result.outcome).toBe("restarting");
    expect(harness.project(projectId)?.state).toBe("draining");
    expect(harness.createWorkerClient).toHaveBeenCalledTimes(1);

    harness.releaseRuns();
    await waitUntil(
      () =>
        harness.project(projectId)?.state === "running" &&
        harness.project(projectId)?.settings.repoDir === "/repos/moved",
    );
    expect(harness.supervisor.status().projects).toHaveLength(1);
    expect(harness.createWorkerClient).toHaveBeenCalledTimes(2);
    await harness.supervisor.stop();
  });

  test("removing a project deletes its settings and lets its runs finish", async () => {
    saveProject({ concurrency: 2 });
    const harness = createHarness();
    await harness.supervisor.start();
    await waitUntil(() => harness.activeRuns() === 2);

    const result = harness.supervisor.removeProject(projectId);

    expect(result.removed).toBe(true);
    expect(result.drainingRuns).toHaveLength(2);
    expect(store.getProject("scarn", projectId)).toBeNull();
    await tick(20);
    expect(harness.activeRuns()).toBe(2);
    expect(harness.project(projectId)?.state).toBe("draining");

    harness.releaseRuns();
    await waitUntil(() => harness.supervisor.status().projects.length === 0);
    expect(harness.activeRuns()).toBe(0);
    expect(harness.supervisor.status().slots.projects).toEqual([]);
    expect(harness.supervisor.removeProject(projectId).removed).toBe(false);
    await harness.supervisor.stop();
  });

  test("a remove racing an add never leaves a project worker behind", async () => {
    const harness = createHarness();
    await harness.supervisor.start();

    const adding = harness.supervisor.addOrUpdateProject(projectInput());
    harness.supervisor.removeProject(projectId);
    await adding;
    harness.releaseRuns();
    await waitUntil(() => harness.supervisor.status().projects.length === 0);

    expect(store.getProject("scarn", projectId)).toBeNull();
    await harness.supervisor.stop();
  });

  test("cancels a run it owns", async () => {
    saveProject({ concurrency: 1 });
    const harness = createHarness();
    await harness.supervisor.start();
    await waitUntil(() => harness.activeRuns() === 1);
    const [run] = harness.supervisor.status().activeRuns;

    expect(harness.supervisor.cancelRun(run?.taskRunId ?? "")).toEqual({
      found: true,
    });
    expect(harness.supervisor.cancelRun("not-a-run")).toEqual({
      found: false,
    });
    await harness.finish();
  });

  test("a forced stop upgrades a drain already under way", async () => {
    saveProject({ concurrency: 2 });
    const harness = createHarness();
    await harness.supervisor.start();
    await waitUntil(() => harness.activeRuns() === 2);

    let drained = false;
    const draining = harness.supervisor.stop().then(() => {
      drained = true;
    });
    await tick(20);
    expect(harness.supervisor.state).toBe("draining");
    expect(drained).toBe(false);
    expect(store.getProject("scarn", projectId)).not.toBeNull();

    const forced = harness.supervisor.stop({ force: true });
    expect(harness.supervisor.state).toBe("stopping");
    harness.releaseRuns();
    await Promise.all([draining, forced]);

    expect(harness.supervisor.state).toBe("stopped");
    expect(harness.workerClient.failTaskRun).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(harness.workerClient.failTaskRun.mock.calls),
    ).toContain(WORKER_STOPPED_ERROR_CODE);
    expect(
      await captureRejection(
        harness.supervisor.addOrUpdateProject(projectInput()),
      ),
    ).toBeInstanceOf(WorkerNotRunningError);
  });

  test("a project in an auth error resumes once its login works again", async () => {
    saveProject();
    const harness = createHarness();
    harness.createWorkerClient.mockImplementationOnce(() =>
      Promise.reject(new WorkerAuthError("auth_missing", "Not signed in.")),
    );

    await harness.supervisor.start();
    expect(harness.project(projectId)?.errorReason).toBe("auth_missing");

    for (const onChange of harness.auth.listeners) onChange();
    await waitUntil(() => harness.project(projectId)?.state === "running");
    await harness.finish();
  });
});
