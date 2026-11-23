/** Ids, counts and runs shared by the Runs list tests. */
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { ProjectRun, RunsCounts } from "./runs-api";

export const id = (suffix: string) =>
  parseUuidV7(`019e9a92-b432-73e8-9341-3519156fb${suffix}`);
export const viewerId = id("900");
export const pipelineId = id("600");
export const automationId = id("650");
export const itemId = id("700");

export const buildCounts = (
  overrides: Partial<RunsCounts> = {},
): RunsCounts => ({
  tabs: { "needs-you": 1, open: 3, finished: 7, all: 10 },
  overall: { inProgress: 3, needsYou: true },
  startedBy: [
    { filter: "me", label: "You", inProgress: 1, needsYou: false },
    {
      filter: automationId,
      label: "Triage new issues",
      inProgress: 2,
      needsYou: true,
    },
  ],
  whatRan: [
    {
      filter: pipelineId,
      whatRan: { kind: "pipeline", id: pipelineId, name: "Ship it" },
      inProgress: 2,
      needsYou: true,
    },
    {
      filter: id("610"),
      whatRan: { kind: "step", id: id("610"), name: "Busy step" },
      inProgress: 1,
      needsYou: false,
    },
    {
      filter: id("611"),
      whatRan: { kind: "step", id: id("611"), name: "Idle step" },
      inProgress: 0,
      needsYou: false,
    },
  ],
  ...overrides,
});

export const buildRun = (overrides: Partial<ProjectRun> = {}): ProjectRun => ({
  type: "pipeline",
  id: id("500"),
  href: `runs/${id("500")}`,
  title: "Fix the login bug",
  whatRan: { kind: "pipeline", id: pipelineId, name: "Ship it" },
  workItem: {
    id: itemId,
    platformKey: "GH-12",
    title: "Fix the login bug",
    parent: null,
  },
  status: "running",
  statusLine: "running implement",
  outcome: null,
  openNodeIds: ["implement"],
  waitingOnYou: false,
  waitingOn: [],
  startedBy: { kind: "user", userId: viewerId, username: "alice" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

export const scheduleId = id("660");

/** A Task the `poller` automation's `hourly` rule started on its own. */
export const buildScheduledRun = (
  overrides: Partial<ProjectRun> = {},
): ProjectRun =>
  buildRun({
    type: "task",
    href: `runs/tasks/${id("520")}`,
    whatRan: { kind: "task", name: "Task" },
    workItem: null,
    startedBy: {
      kind: "schedule",
      automationId,
      key: "poller",
      title: "Poller",
      schedule: { id: scheduleId, key: "hourly", removed: false },
      user: null,
    },
    ...overrides,
  });
