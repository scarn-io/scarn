/**
 * What the Runs list is scoped to, in words: the header's title, the tab a
 * narrowed status belongs to, and the work item an `item` filter names.
 */
import {
  PROJECT_RUN_STATUS_TABS,
  type ProjectRunStatus,
  type ProjectRunStatusFilter,
  type ProjectRunStatusTab,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import type { ProjectRun, RunsCounts } from "./runs-api";
import type { RunsNav } from "./runs-params";

export const isRunsStatusTab = (
  status: ProjectRunStatusFilter,
): status is ProjectRunStatusTab => status in PROJECT_RUN_STATUS_TABS;

/**
 * The tab a status filter shows under: a tab is itself; a single status
 * (a narrowed deep link such as `status=ended`) is In progress or Finished.
 */
export function runsTabOf(status: ProjectRunStatusFilter): ProjectRunStatusTab {
  if (isRunsStatusTab(status)) return status;
  return (PROJECT_RUN_STATUS_TABS.open as readonly ProjectRunStatus[]).includes(
    status,
  )
    ? "open"
    : "finished";
}

/** The single status a deep link narrowed the list to, if any. */
export const narrowedRunsStatus = (
  status: ProjectRunStatusFilter,
): ProjectRunStatus | null => (isRunsStatusTab(status) ? null : status);

export type ScopedWorkItem = { platformKey: string; title: string };

/** The work item `nav.item` names, found on the loaded rows. */
export function scopedWorkItem(
  itemId: string | undefined,
  runs: readonly ProjectRun[],
): ScopedWorkItem | null {
  if (itemId === undefined) return null;
  for (const run of runs) {
    const { workItem } = run;
    if (workItem?.id === itemId) return workItem;
    if (workItem?.parent?.id === itemId) return workItem.parent;
  }
  return null;
}

/** The header title for the list's scope. */
export function runsTitle(
  nav: RunsNav,
  counts: RunsCounts | null,
  item: ScopedWorkItem | null,
  automationLabel: (id: string) => string | undefined,
): string {
  if (nav.item !== undefined) {
    return item ? `${item.platformKey} · ${item.title}` : "Runs";
  }
  if (nav.by === "me") return "Started by you";
  if (nav.whatRan === "task") return "Tasks";
  if (nav.by !== undefined) {
    const label =
      counts?.startedBy.find((entry) => entry.filter === nav.by)?.label ??
      automationLabel(nav.by);
    if (label !== undefined) return label;
  }
  if (nav.whatRan !== undefined) {
    const name = counts?.whatRan.find((entry) => entry.filter === nav.whatRan)
      ?.whatRan.name;
    if (name !== undefined) return name;
  }
  return "Runs";
}
