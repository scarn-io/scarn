/**
 * SQLite-backed `WorkerSettingsStore`. Shares `~/.scarn/db.sqlite` (or
 * `SCARN_LOCAL_DB_PATH`) with the local runtime session store; its tables
 * are created on open with `CREATE TABLE IF NOT EXISTS`.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getDefaultLocalRuntimeSessionDbPath } from "../../task-run/infra/sqlite-local-runtime-session-store";
import type {
  SaveWorkerInstanceInput,
  UpsertWorkerProjectInput,
  WorkerInstanceSettings,
  WorkerProjectSettings,
  WorkerSettingsStore,
} from "../contracts/worker-settings";

type WorkerProjectRow = Omit<WorkerProjectSettings, "preserveRuntime"> & {
  preserveRuntime: number;
};

const INSTANCE_COLUMNS = `
  instance,
  base_url AS baseUrl,
  max_concurrency AS maxConcurrency,
  updated_at AS updatedAt`;

const PROJECT_COLUMNS = `
  instance,
  project_id AS projectId,
  project_ref AS projectRef,
  repo_dir AS repoDir,
  source_branch AS sourceBranch,
  base_url AS baseUrl,
  added_by_user_id AS addedByUserId,
  concurrency,
  work_item_id AS workItemId,
  preserve_runtime AS preserveRuntime,
  created_at AS createdAt,
  updated_at AS updatedAt`;

export type SqliteWorkerSettingsStoreOptions = {
  databasePath?: string;
  now?: () => Date;
};

export class SqliteWorkerSettingsStore implements WorkerSettingsStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: SqliteWorkerSettingsStoreOptions = {}) {
    const databasePath =
      options.databasePath ?? getDefaultLocalRuntimeSessionDbPath();
    this.now = options.now ?? (() => new Date());
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.run(`
      CREATE TABLE IF NOT EXISTS worker_instances (
        instance TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS worker_projects (
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
  }

  getInstance(instance: string): WorkerInstanceSettings | null {
    return (
      this.db
        .query<WorkerInstanceSettings, [string]>(
          `SELECT ${INSTANCE_COLUMNS} FROM worker_instances WHERE instance = ?`,
        )
        .get(instance) ?? null
    );
  }

  saveInstance(input: SaveWorkerInstanceInput): WorkerInstanceSettings {
    this.db
      .query(
        `INSERT INTO worker_instances (instance, base_url, max_concurrency, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (instance) DO UPDATE SET
           base_url = excluded.base_url,
           max_concurrency = excluded.max_concurrency,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.instance,
        input.baseUrl,
        input.maxConcurrency,
        this.now().toISOString(),
      );
    return this.requireInstance(input.instance);
  }

  listProjects(instance: string): WorkerProjectSettings[] {
    return this.db
      .query<WorkerProjectRow, [string]>(
        `SELECT ${PROJECT_COLUMNS} FROM worker_projects
         WHERE instance = ? ORDER BY created_at, project_id`,
      )
      .all(instance)
      .map(toProjectSettings);
  }

  getProject(
    instance: string,
    projectId: string,
  ): WorkerProjectSettings | null {
    const row = this.db
      .query<WorkerProjectRow, [string, string]>(
        `SELECT ${PROJECT_COLUMNS} FROM worker_projects
         WHERE instance = ? AND project_id = ?`,
      )
      .get(instance, projectId);
    return row ? toProjectSettings(row) : null;
  }

  upsertProject(input: UpsertWorkerProjectInput): WorkerProjectSettings {
    const now = this.now().toISOString();
    this.db
      .query(
        `INSERT INTO worker_projects (
           instance, project_id, project_ref, repo_dir, source_branch,
           base_url, added_by_user_id, concurrency, work_item_id,
           preserve_runtime, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (instance, project_id) DO UPDATE SET
           project_ref = excluded.project_ref,
           repo_dir = excluded.repo_dir,
           source_branch = excluded.source_branch,
           base_url = excluded.base_url,
           added_by_user_id = excluded.added_by_user_id,
           concurrency = excluded.concurrency,
           work_item_id = excluded.work_item_id,
           preserve_runtime = excluded.preserve_runtime,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.instance,
        input.projectId,
        input.projectRef,
        input.repoDir,
        input.sourceBranch,
        input.baseUrl,
        input.addedByUserId,
        input.concurrency,
        input.workItemId,
        input.preserveRuntime ? 1 : 0,
        now,
        now,
      );
    const saved = this.getProject(input.instance, input.projectId);
    if (!saved) {
      throw new Error(
        `Worker project ${input.projectId} was not saved for instance ${input.instance}`,
      );
    }
    return saved;
  }

  deleteProject(instance: string, projectId: string): boolean {
    const result = this.db
      .query(
        "DELETE FROM worker_projects WHERE instance = ? AND project_id = ?",
      )
      .run(instance, projectId);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private requireInstance(instance: string): WorkerInstanceSettings {
    const saved = this.getInstance(instance);
    if (!saved) {
      throw new Error(`Worker instance ${instance} was not saved`);
    }
    return saved;
  }
}

function toProjectSettings(row: WorkerProjectRow): WorkerProjectSettings {
  return { ...row, preserveRuntime: row.preserveRuntime !== 0 };
}
