/** Automations and a pipeline for the Pipelines & Automations page tests. */
import {
  parseUuidV7,
  type AutomationListItemContract,
  type PipelineDefinitionContract,
} from "@scarn/api/frontend-contracts";

export const PROJECT_ID = "019e9a92-b432-73e8-9341-3519156fa900";
export const PIPELINE_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa101");
export const AUTOMATION_ID = parseUuidV7(
  "019e9a92-b432-73e8-9341-3519156fa801",
);
export const IDLE_AUTOMATION_ID = parseUuidV7(
  "019e9a92-b432-73e8-9341-3519156fa802",
);
const STAMP = "2026-11-01T12:00:00.000Z";

export const triage: AutomationListItemContract = {
  id: AUTOMATION_ID,
  projectId: parseUuidV7(PROJECT_ID),
  key: "triage",
  title: "Triage new issues",
  scope: "project",
  enabled: false,
  latestVersion: {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa811"),
    version: 2,
    schemaVersion: 1,
    contentHash: "hash",
    document: {
      kind: "automation",
      schemaVersion: 1,
      key: "triage",
      scope: "project",
      rules: [
        {
          key: "on-work-item-created",
          event: "workItem.created",
          next: {
            routes: [
              { kind: "pipeline", to: "ship-it", on: "workItem" },
              { kind: "step", to: "label", on: "workItem" },
            ],
          },
        },
      ],
    },
    publishedAt: STAMP,
  },
  createdAt: STAMP,
  updatedAt: STAMP,
  schedules: [],
};

export const wayfinder: AutomationListItemContract = {
  ...triage,
  id: IDLE_AUTOMATION_ID,
  key: "wayfinder",
  title: "Wayfinder",
  scope: "workItem",
  latestVersion: null,
};

export const POLLER_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa803");
export const SCHEDULE_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901");
export const HELD_TASK_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa9aa");
export const STARTED_TASK_ID = parseUuidV7(
  "019e9a92-b432-73e8-9341-3519156fa9bb",
);

/** A project automation with one schedule rule that has been failing. */
export const poller: AutomationListItemContract = {
  ...triage,
  id: POLLER_ID,
  key: "poller",
  title: "Poll Linear",
  enabled: true,
  latestVersion: null,
  schedules: [
    {
      id: SCHEDULE_ID,
      key: "hourly",
      cron: "0 * * * *",
      timezone: "Europe/Paris",
      concurrency: { max: 1, waiting: 0 },
      nextRunAt: "2099-01-01T00:00:00.000Z",
      lastFiredAt: STAMP,
      lastTask: {
        id: HELD_TASK_ID,
        status: "failed",
        scheduledFor: STAMP,
      },
      failureStreak: 3,
      lastSkippedAt: STAMP,
      skippedCountSinceFire: 2,
      lastError: {
        message: "Step poll-linear has no active version",
        at: STAMP,
      },
    },
  ],
};

export const shipIt: PipelineDefinitionContract = {
  id: PIPELINE_ID,
  projectId: parseUuidV7(PROJECT_ID),
  key: "ship-it",
  name: "Ship it",
  archivedAt: null,
  currentVersion: {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa111"),
    pipelineDefinitionId: PIPELINE_ID,
    version: 3,
    schemaVersion: 1,
    contentHash: "hash",
    definition: {
      schemaVersion: 1,
      key: "ship-it",
      start: { to: "review" },
      nodes: { review: { kind: "step", step: "review" } },
    },
    steps: [],
    createdAt: STAMP,
  },
  createdAt: STAMP,
  updatedAt: STAMP,
};
