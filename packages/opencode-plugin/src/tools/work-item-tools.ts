import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import {
  hasGrantFor,
  type CurrentExecutionInfo,
} from "./_shared/current-execution";
import { findGrant } from "./_shared/work-item-grants";
import { createScarnCreateWorkItemTool } from "./scarn-create-work-item";
import { createScarnGetWorkItemTool } from "./scarn-get-work-item";
import {
  createScarnBlockWorkItemTool,
  createScarnCloseWorkItemTool,
  createScarnCommentOnWorkItemTool,
  createScarnLabelWorkItemTool,
  createScarnSetWorkItemDescriptionTool,
} from "./scarn-work-item-change-tools";

/**
 * The work item tools a run's Task may use: one per action the Task has a
 * grant for (on any scope). Outside a run on a work item, only the create
 * tool, and only with a `create` grant on `project` (a scheduled Task). The
 * server re-checks every change.
 */
export function createWorkItemTools(
  directory: string,
  info: CurrentExecutionInfo | null,
): ToolInfo[] {
  if (info === null) {
    return [];
  }
  const { grants } = info;
  if (info.workItemId === null) {
    return findGrant(grants, "create", "project")
      ? [createScarnCreateWorkItemTool(directory, grants)]
      : [];
  }
  const tools: ToolInfo[] = [];
  if (hasGrantFor(grants, "read")) {
    tools.push(createScarnGetWorkItemTool(directory, grants));
  }
  if (hasGrantFor(grants, "update")) {
    tools.push(createScarnSetWorkItemDescriptionTool(directory, grants));
  }
  if (hasGrantFor(grants, "label")) {
    tools.push(createScarnLabelWorkItemTool(directory, grants));
  }
  if (hasGrantFor(grants, "comment")) {
    tools.push(createScarnCommentOnWorkItemTool(directory, grants));
  }
  if (hasGrantFor(grants, "close")) {
    tools.push(createScarnCloseWorkItemTool(directory, grants));
  }
  if (hasGrantFor(grants, "block")) {
    tools.push(createScarnBlockWorkItemTool(directory, grants));
  }
  if (hasGrantFor(grants, "create")) {
    tools.push(createScarnCreateWorkItemTool(directory, grants));
  }
  return tools;
}
