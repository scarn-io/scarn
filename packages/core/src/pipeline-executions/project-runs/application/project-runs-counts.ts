import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  isProjectRunInProgress,
  PROJECT_RUN_STATUS_TABS,
  projectRunStatusTabValues,
  type ProjectRunsCountsContract,
  type ProjectRunWhatRan,
} from "../contracts/project-runs-contracts";
import type {
  ProjectRunCountGroup,
  ProjectRunsFacetFilter,
} from "./project-runs-reader";

type FacetCount = { inProgress: number; needsYou: boolean };

const emptyFacet = (): FacetCount => ({ inProgress: 0, needsYou: false });

const addTo = (facet: FacetCount, group: ProjectRunCountGroup): void => {
  if (isProjectRunInProgress(group.status)) {
    facet.inProgress += group.count;
  }
  if (group.status === "needs-you" && group.count > 0) {
    facet.needsYou = true;
  }
};

const matchesWhatRan = (
  group: ProjectRunCountGroup,
  filter: ProjectRunsFacetFilter,
): boolean =>
  (filter.whatRan === undefined || group.whatRanFilter === filter.whatRan) &&
  (filter.atNode === undefined || group.atNode);

const matchesStartedBy = (
  group: ProjectRunCountGroup,
  filter: ProjectRunsFacetFilter,
): boolean =>
  filter.startedBy === undefined ||
  (filter.startedBy === "me"
    ? group.startedByActor
    : filter.startedBy === "scheduled"
      ? group.scheduled
      : group.startedByAutomation?.id === filter.startedBy);

const whatRanOf = (group: ProjectRunCountGroup): ProjectRunWhatRan => {
  switch (group.type) {
    case "pipeline":
      return {
        kind: "pipeline",
        id: parseUuidV7(group.whatRanFilter),
        name: group.whatRanName,
      };
    case "step":
      return {
        kind: "step",
        id: parseUuidV7(group.whatRanFilter),
        name: group.whatRanName,
      };
    case "task":
      return { kind: "task", name: group.whatRanName };
  }
};

const WHAT_RAN_ORDER: Record<ProjectRunWhatRan["kind"], number> = {
  pipeline: 0,
  step: 1,
  task: 2,
};

/**
 * Rolls the reader's count groups up into the Runs list's counts. Tabs count
 * every filter but `status`; each sidebar facet ignores its own filter (so
 * picking an automation still shows the others), and `overall` ignores both.
 * `includeViewer` adds the `You` entry, for members.
 */
export const projectRunsCounts = (
  groups: readonly ProjectRunCountGroup[],
  filter: ProjectRunsFacetFilter,
  includeViewer: boolean,
): ProjectRunsCountsContract => {
  const tabs = Object.fromEntries(
    projectRunStatusTabValues.map((tab) => [tab, 0]),
  ) as ProjectRunsCountsContract["tabs"];
  const overall = emptyFacet();
  const you = emptyFacet();
  const scheduled = emptyFacet();
  let anyScheduled = false;
  const automations = new Map<
    string,
    FacetCount & {
      label: string;
      filter: ProjectRunsCountsContract["startedBy"][number]["filter"];
    }
  >();
  const whatRan = new Map<
    string,
    FacetCount & {
      whatRan: ProjectRunWhatRan;
      filter: ProjectRunsCountsContract["whatRan"][number]["filter"];
    }
  >();
  for (const group of groups) {
    const inWhatRan = matchesWhatRan(group, filter);
    const inStartedBy = matchesStartedBy(group, filter);
    addTo(overall, group);
    if (inWhatRan && inStartedBy) {
      for (const tab of projectRunStatusTabValues) {
        if (
          (PROJECT_RUN_STATUS_TABS[tab] as readonly string[]).includes(
            group.status,
          )
        ) {
          tabs[tab] += group.count;
        }
      }
    }
    if (inWhatRan) {
      if (group.startedByActor) {
        addTo(you, group);
      }
      if (group.scheduled) {
        anyScheduled = true;
        addTo(scheduled, group);
      }
      const automation = group.startedByAutomation;
      if (automation) {
        const entry = automations.get(automation.id) ?? {
          ...emptyFacet(),
          filter: automation.id,
          label: automation.title ?? automation.key,
        };
        addTo(entry, group);
        automations.set(automation.id, entry);
      }
    }
    if (inStartedBy) {
      const entry = whatRan.get(group.whatRanFilter) ?? {
        ...emptyFacet(),
        filter: group.whatRanFilter,
        whatRan: whatRanOf(group),
      };
      addTo(entry, group);
      whatRan.set(group.whatRanFilter, entry);
    }
  }
  return {
    tabs,
    overall,
    startedBy: [
      ...(includeViewer
        ? [{ ...you, filter: "me" as const, label: "You" }]
        : []),
      ...(anyScheduled || filter.startedBy === "scheduled"
        ? [{ ...scheduled, filter: "scheduled" as const, label: "Scheduled" }]
        : []),
      ...[...automations.values()].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    ],
    whatRan: [...whatRan.values()].sort(
      (left, right) =>
        WHAT_RAN_ORDER[left.whatRan.kind] -
          WHAT_RAN_ORDER[right.whatRan.kind] ||
        left.whatRan.name.localeCompare(right.whatRan.name),
    ),
  };
};
