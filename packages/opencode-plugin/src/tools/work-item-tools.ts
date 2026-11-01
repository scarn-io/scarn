import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import type { CurrentExecutionInfo } from "./_shared/current-execution";
import { createScarnCreateWorkItemTool } from "./scarn-create-work-item";
import { createScarnGetWorkItemTool } from "./scarn-get-work-item";
import {
  createScarnBlockWorkItemTool,
  createScarnCloseWorkItemTool,
  createScarnCommentOnWorkItemTool,
  createScarnSetWorkItemDescriptionTool,
  createScarnStartTaskTool,
} from "./scarn-work-item-change-tools";
import { createScarnWaitForWorkTool } from "./scarn-wait-for-work";

/**
 * The work item tools a run's Task may use: none outside a run on a work
 * item, the `self` tools with that permission, plus creating children with
 * `children`. The server re-checks every change.
 */
export function createWorkItemTools(
  directory: string,
  info: CurrentExecutionInfo | null,
): ToolInfo[] {
  if (info?.workItemId == null) {
    return [];
  }
  const tools: ToolInfo[] = [];
  if (info.workItemPermissions.includes("self")) {
    tools.push(
      createScarnGetWorkItemTool(directory),
      createScarnSetWorkItemDescriptionTool(directory),
      createScarnCommentOnWorkItemTool(directory),
      createScarnCloseWorkItemTool(directory),
      createScarnBlockWorkItemTool(directory),
      createScarnStartTaskTool(directory),
      createScarnWaitForWorkTool(directory),
    );
  }
  if (info.workItemPermissions.includes("children")) {
    tools.push(createScarnCreateWorkItemTool(directory));
  }
  return tools;
}
