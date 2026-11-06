/**
 * The work item changes an agent's tools record during a run
 * (`.scarn/work-item-changes.json`). The opencode plugin appends to it; the
 * worker sends the list with the run's completion, and the server checks and
 * applies it then. Nothing here is applied during the run.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const WORK_ITEM_CHANGES_RELATIVE_PATH = ".scarn/work-item-changes.json";

export const WORK_ITEM_CLOSE_REASONS = [
  "completed",
  "out_of_scope",
  "superseded",
] as const;

export type WorkItemCloseReason = (typeof WORK_ITEM_CLOSE_REASONS)[number];

export type WorkItemChange =
  | { kind: "label"; workItemId: string; add?: string[]; remove?: string[] }
  | {
      kind: "block";
      blockedWorkItemId: string;
      blockingWorkItemId: string;
      remove?: boolean;
    }
  | {
      kind: "describe";
      workItemId: string;
      description: string;
      descriptionVersion: number;
    }
  | { kind: "comment"; workItemId: string; body: string }
  | {
      kind: "close";
      workItemId: string;
      reason: WorkItemCloseReason;
      resolution?: string | null;
    };

const workItemChangesFileSchema = z.object({
  changes: z.array(
    z.looseObject({
      kind: z.enum(["label", "block", "describe", "comment", "close"]),
    }),
  ),
});

export function buildWorkItemChangesPath(workspacePath: string): string {
  return path.join(workspacePath, WORK_ITEM_CHANGES_RELATIVE_PATH);
}

/** The changes recorded so far; a missing file means none. */
export async function readWorkItemChanges(
  workspacePath: string,
): Promise<WorkItemChange[]> {
  let raw: string;
  try {
    raw = await readFile(buildWorkItemChangesPath(workspacePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const parsed = workItemChangesFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${WORK_ITEM_CHANGES_RELATIVE_PATH} is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data.changes as WorkItemChange[];
}

const workItemChangesLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` while holding this process's lock on the workspace's changes
 * file. An agent can call several work item tools in parallel, and each one
 * reads the recorded changes, checks against them and appends; holding the
 * lock across all of that keeps parallel calls from losing each other's
 * changes or seeing a half-written file.
 */
export async function withWorkItemChangesLock<T>(
  workspacePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = buildWorkItemChangesPath(workspacePath);
  const previous = workItemChangesLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const released = run.then(
    () => undefined,
    () => undefined,
  );
  workItemChangesLocks.set(key, released);
  try {
    return await run;
  } finally {
    if (workItemChangesLocks.get(key) === released) {
      workItemChangesLocks.delete(key);
    }
  }
}

/**
 * Appends one change. The file is replaced by a rename, so a reader sees the
 * old list or the new one, never a partial write. Callers that read the
 * recorded changes before appending hold {@link withWorkItemChangesLock}.
 */
export async function appendWorkItemChange(
  workspacePath: string,
  change: WorkItemChange,
): Promise<WorkItemChange[]> {
  const changes = [...(await readWorkItemChanges(workspacePath)), change];
  const filePath = buildWorkItemChangesPath(workspacePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({ changes }, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return changes;
}

/**
 * Deletes the file. Called when a run's workspace is set up, so changes
 * committed on an earlier step's branch are never sent again.
 */
export async function removeWorkItemChanges(
  workspacePath: string,
): Promise<void> {
  await rm(buildWorkItemChangesPath(workspacePath), { force: true });
}
