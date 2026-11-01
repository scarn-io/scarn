/**
 * The work item changes an agent's tools record during a run
 * (`.scarn/work-item-changes.json`). The opencode plugin appends to it; the
 * worker sends the list with the run's completion, and the server checks and
 * applies it then. Nothing here is applied during the run.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const WORK_ITEM_CHANGES_RELATIVE_PATH = ".scarn/work-item-changes.json";

/** At most this many items created in one run; the server checks it too. */
export const MAX_WORK_ITEMS_CREATED_PER_RUN = 10;

export const WORK_ITEM_CLOSE_REASONS = [
  "completed",
  "out_of_scope",
  "superseded",
] as const;

export type WorkItemCloseReason = (typeof WORK_ITEM_CLOSE_REASONS)[number];

export type WorkItemChange =
  | {
      kind: "create";
      workItemId: string;
      title: string;
      description: string;
      fields?: Record<string, unknown>;
      blockedBy?: string[];
    }
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
    }
  | { kind: "startTask"; workItemId: string; stepKey: string };

const workItemChangesFileSchema = z.object({
  changes: z.array(
    z.looseObject({
      kind: z.enum([
        "create",
        "block",
        "describe",
        "comment",
        "close",
        "startTask",
      ]),
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

export async function appendWorkItemChange(
  workspacePath: string,
  change: WorkItemChange,
): Promise<WorkItemChange[]> {
  const changes = [...(await readWorkItemChanges(workspacePath)), change];
  const filePath = buildWorkItemChangesPath(workspacePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ changes }, null, 2)}\n`,
    "utf8",
  );
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
