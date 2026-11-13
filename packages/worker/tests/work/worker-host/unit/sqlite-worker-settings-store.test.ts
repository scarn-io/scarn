import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpsertWorkerProjectInput } from "../../../../src/work/worker-host/contracts/worker-settings";
import { SqliteWorkerSettingsStore } from "../../../../src/work/worker-host/infra/sqlite-worker-settings-store";

function projectInput(
  overrides: Partial<UpsertWorkerProjectInput> = {},
): UpsertWorkerProjectInput {
  return {
    instance: "scarn",
    projectId: "proj-1",
    projectRef: "acme/widgets",
    repoDir: "/repos/widgets",
    sourceBranch: "main",
    baseUrl: "https://scarn.example",
    addedByUserId: "user-1",
    concurrency: null,
    workItemId: null,
    preserveRuntime: false,
    ...overrides,
  };
}

describe("SqliteWorkerSettingsStore", () => {
  let dir: string;
  let dbPath: string;
  let clock: Date;
  let store: SqliteWorkerSettingsStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "scarn-worker-settings-"));
    dbPath = path.join(dir, "nested", "db.sqlite");
    clock = new Date("2026-01-01T00:00:00.000Z");
    store = new SqliteWorkerSettingsStore({
      databasePath: dbPath,
      now: () => clock,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips instance settings and upserts them", () => {
    expect(store.getInstance("scarn")).toBeNull();

    store.saveInstance({
      instance: "scarn",
      baseUrl: "https://a.example",
      maxConcurrency: 2,
    });
    clock = new Date("2026-01-02T00:00:00.000Z");
    const updated = store.saveInstance({
      instance: "scarn",
      baseUrl: "https://b.example",
      maxConcurrency: 4,
    });

    expect(updated).toEqual({
      instance: "scarn",
      baseUrl: "https://b.example",
      maxConcurrency: 4,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(store.getInstance("scarn")).toEqual(updated);
  });

  test("round-trips project settings including nullable fields", () => {
    const saved = store.upsertProject(
      projectInput({
        concurrency: 3,
        workItemId: "wi-9",
        preserveRuntime: true,
      }),
    );

    expect(saved).toEqual({
      ...projectInput({
        concurrency: 3,
        workItemId: "wi-9",
        preserveRuntime: true,
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getProject("scarn", "proj-1")).toEqual(saved);
    expect(store.listProjects("scarn")).toEqual([saved]);
  });

  test("adding a project again updates it and keeps createdAt", () => {
    store.upsertProject(projectInput({ concurrency: 2 }));
    clock = new Date("2026-01-05T00:00:00.000Z");
    const updated = store.upsertProject(
      projectInput({ sourceBranch: "develop", concurrency: null }),
    );

    expect(updated.sourceBranch).toBe("develop");
    expect(updated.concurrency).toBeNull();
    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(store.listProjects("scarn")).toHaveLength(1);
  });

  test("keeps instances separate", () => {
    store.saveInstance({
      instance: "scarn",
      baseUrl: "https://prod.example",
      maxConcurrency: 1,
    });
    store.saveInstance({
      instance: "scarn-dev",
      baseUrl: "http://localhost:3000",
      maxConcurrency: 8,
    });
    store.upsertProject(projectInput());
    store.upsertProject(
      projectInput({ instance: "scarn-dev", repoDir: "/dev/widgets" }),
    );

    expect(store.getInstance("scarn")?.maxConcurrency).toBe(1);
    expect(store.getInstance("scarn-dev")?.maxConcurrency).toBe(8);
    expect(store.getProject("scarn", "proj-1")?.repoDir).toBe("/repos/widgets");
    expect(store.getProject("scarn-dev", "proj-1")?.repoDir).toBe(
      "/dev/widgets",
    );

    expect(store.deleteProject("scarn-dev", "proj-1")).toBe(true);
    expect(store.deleteProject("scarn-dev", "proj-1")).toBe(false);
    expect(store.listProjects("scarn-dev")).toEqual([]);
    expect(store.listProjects("scarn")).toHaveLength(1);
  });

  test("persists across reopen of the same database file", () => {
    store.upsertProject(projectInput());
    store.close();
    store = new SqliteWorkerSettingsStore({ databasePath: dbPath });

    expect(store.getProject("scarn", "proj-1")?.projectRef).toBe(
      "acme/widgets",
    );
  });
});
