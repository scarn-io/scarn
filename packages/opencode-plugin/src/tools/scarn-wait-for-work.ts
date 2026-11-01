import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { resolveWorktree } from "./_shared/resolve-worktree";

export const SCARN_WAIT_FOR_WORK_TOOL = "scarn-wait-for-work";

export const WAIT_FOR_WORK_RELATIVE_PATH = ".scarn/wait-for-work.json";

export const WAIT_FOR_WORK_ACCEPTED_MESSAGE =
  "End your turn now. Your session is saved, and you continue once your work item has no open blockers, told which blockers closed and how.";

/**
 * Records that the agent wants to end its run waiting on its work item's
 * blockers rather than handing over to a person, by writing
 * {@link WAIT_FOR_WORK_RELATIVE_PATH}. The worker reads it once the turn ends.
 */
export async function waitForWork(directory: string): Promise<string> {
  const worktree = await resolveWorktree(directory);
  const filePath = path.join(worktree, WAIT_FOR_WORK_RELATIVE_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ requestedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return WAIT_FOR_WORK_ACCEPTED_MESSAGE;
}

/** The `scarn-wait-for-work` tool, bound to the plugin's directory. */
export function createScarnWaitForWorkTool(directory: string): ToolInfo {
  return {
    name: SCARN_WAIT_FOR_WORK_TOOL,
    description:
      "End this run waiting on your work item's blockers instead of handing over to a person. Block your own item first (scarn-block-work-item), then call this and end your turn. You continue in this session once every blocker has closed. Counts as a turn.",
    input: { type: "object", properties: {} },
    options: { codemode: false },
    execute: async () => ({ content: await waitForWork(directory) }),
  };
}
