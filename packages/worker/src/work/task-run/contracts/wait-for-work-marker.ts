/**
 * The marker `scarn-wait-for-work` writes: the agent wants its run to end
 * waiting on its work item's blockers instead of handing over to a person.
 */
import { access, rm } from "node:fs/promises";
import path from "node:path";

export const WAIT_FOR_WORK_RELATIVE_PATH = ".scarn/wait-for-work.json";

export function buildWaitForWorkPath(workspacePath: string): string {
  return path.join(workspacePath, WAIT_FOR_WORK_RELATIVE_PATH);
}

export async function hasWaitForWorkMarker(
  workspacePath: string,
): Promise<boolean> {
  try {
    await access(buildWaitForWorkPath(workspacePath));
    return true;
  } catch {
    return false;
  }
}

export async function removeWaitForWorkMarker(
  workspacePath: string,
): Promise<void> {
  await rm(buildWaitForWorkPath(workspacePath), { force: true });
}
