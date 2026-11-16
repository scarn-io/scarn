import { Database } from "bun:sqlite";
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
      projectInput({ repoDir: "/repos/moved", concurrency: null }),
    );

    expect(updated.repoDir).toBe("/repos/moved");
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

  test("opens a database with the old source_branch column and saves to it", () => {
    store.close();
    const legacyPath = path.join(dir, "legacy.sqlite");
    const legacy = new Database(legacyPath, { create: true, strict: true });
    legacy.run(`
      CREATE TABLE worker_projects (
        instance TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_ref TEXT NOT NULL,
        repo_dir TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        base_url TEXT NOT NULL,
        added_by_user_id TEXT NOT NULL,
        concurrency INTEGER,
        work_item_id TEXT,
        preserve_runtime INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance, project_id)
      );
    `);
    legacy.run(
      `INSERT INTO worker_projects VALUES
         ('scarn', 'proj-old', 'acme/old', '/repos/old', 'develop',
          'https://scarn.example', 'user-1', NULL, NULL, 0,
          '2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z')`,
    );
    legacy.close();

    store = new SqliteWorkerSettingsStore({
      databasePath: legacyPath,
      now: () => clock,
    });

    expect(store.getProject("scarn", "proj-old")?.repoDir).toBe("/repos/old");
    expect(store.upsertProject(projectInput()).projectId).toBe("proj-1");
    expect(store.listProjects("scarn")).toHaveLength(2);
  });
});
