/** Automations and a pipeline for the Pipelines & Automations page tests. */
import {
  parseUuidV7,
  type AutomationContract,
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

export const triage: AutomationContract = {
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
};

export const wayfinder: AutomationContract = {
  ...triage,
  id: IDLE_AUTOMATION_ID,
  key: "wayfinder",
  title: "Wayfinder",
  scope: "workItem",
  latestVersion: null,
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
