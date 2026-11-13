/**
 * Saved background-worker settings, keyed by worker instance. The worker
 * restores these on start: the instance's base URL and machine-wide
 * concurrency, plus every project loop it was running.
 */

export type WorkerInstanceSettings = {
  instance: string;
  baseUrl: string;
  maxConcurrency: number;
  updatedAt: string;
};

export type SaveWorkerInstanceInput = Omit<WorkerInstanceSettings, "updatedAt">;

export type WorkerProjectSettings = {
  instance: string;
  projectId: string;
  projectRef: string;
  repoDir: string;
  sourceBranch: string;
  baseUrl: string;
  addedByUserId: string;
  concurrency: number | null;
  workItemId: string | null;
  preserveRuntime: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UpsertWorkerProjectInput = Omit<
  WorkerProjectSettings,
  "createdAt" | "updatedAt"
>;

export type WorkerSettingsStore = {
  getInstance(instance: string): WorkerInstanceSettings | null;
  saveInstance(input: SaveWorkerInstanceInput): WorkerInstanceSettings;
  listProjects(instance: string): WorkerProjectSettings[];
  getProject(instance: string, projectId: string): WorkerProjectSettings | null;
  upsertProject(input: UpsertWorkerProjectInput): WorkerProjectSettings;
  deleteProject(instance: string, projectId: string): boolean;
  close(): void;
};
