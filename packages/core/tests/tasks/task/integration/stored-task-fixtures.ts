/**
 * Golden stored `tasks` rows (`../fixtures/v1-*.json`) and the raw inserts
 * that write them, bypassing the entity, to stand in for Tasks created by
 * older code. See `docs/persistence/json-columns.md`.
 */
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  automationSchedules,
  automations,
  projects,
  type taskKindEnum,
  tasks,
  workItems,
} from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import v1Agent from "../fixtures/v1-agent.json";
import v1AgentBundleField from "../fixtures/v1-agent-bundle-field.json";
import v1Code from "../fixtures/v1-code.json";
import v1Failed from "../fixtures/v1-failed.json";
import v1HeldChanges from "../fixtures/v1-held-changes.json";
import v1McpTool from "../fixtures/v1-mcp-tool.json";
import v1Scheduled from "../fixtures/v1-scheduled.json";

export type StoredTaskFixture = {
  schemaVersion: number;
  kind: string;
  owner: string;
  status: string;
  prompt: string | null;
  entrypointJson: unknown;
  toolCallJson: unknown;
  resultSchemaJson: unknown;
  inputJson: unknown;
  retryJson: unknown;
  environmentSelectionJson: unknown;
  grantsJson: unknown;
  /** Absent from fixtures written before the column existed; reads as `[]`. */
  heldWorkItemChangesJson?: unknown;
  resultJson: unknown;
  errorJson: unknown;
};

export const storedTaskFixtures = {
  agent: v1Agent,
  "agent-bundle-field": v1AgentBundleField,
  code: v1Code,
  "mcp-tool": v1McpTool,
  scheduled: v1Scheduled,
  failed: v1Failed,
  "held-changes": v1HeldChanges,
} as const satisfies Record<string, StoredTaskFixture>;

export const v1FailedTask: StoredTaskFixture = v1Failed;

export type StoredTaskOwners = {
  projectId: UuidV7;
  workItemId: UuidV7;
  scheduleId: UuidV7;
};

/**
 * A work item and a schedule in `projectId` (else a new project) that a
 * fixture Task can belong to.
 */
export const seedStoredTaskOwners = async (
  existingProjectId?: UuidV7,
): Promise<StoredTaskOwners> => {
  const projectId = existingProjectId ?? createUuidV7();
  const workItemId = createUuidV7();
  const automationId = createUuidV7();
  const scheduleId = createUuidV7();
  const db = getDb();
  if (existingProjectId === undefined) {
    await db.insert(projects).values({
      id: projectId,
      name: "Task stored json compat",
      slug: `task-stored-json-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
  }
  await db.insert(workItems).values({
    id: workItemId,
    projectId,
    platform: "github",
    platformKey: `#${crypto.randomUUID()}`,
    title: "Example work item",
  });
  await db.insert(automations).values({
    id: automationId,
    projectId,
    key: `scheduled-${crypto.randomUUID()}`,
    scope: "project",
    enabled: true,
  });
  await db.insert(automationSchedules).values({
    id: scheduleId,
    automationId,
    key: "poll",
    cron: "0 * * * *",
    timezone: "UTC",
    concurrencyMax: 1,
    concurrencyWaiting: 0,
    nextRunAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  return { projectId, workItemId, scheduleId };
};

let scheduledCount = 0;

/** Writes `fixture` as a raw `tasks` row owned by `owners` and returns its id. */
export const insertStoredTask = async (
  owners: StoredTaskOwners,
  stored: StoredTaskFixture,
  overrides: Partial<StoredTaskFixture> = {},
): Promise<UuidV7> => {
  const fixture = { ...stored, ...overrides };
  const id = createUuidV7();
  scheduledCount += 1;
  const scheduled = fixture.owner === "schedule";
  await getDb()
    .insert(tasks)
    .values({
      id,
      projectId: owners.projectId,
      workItemId: scheduled ? null : owners.workItemId,
      startedByScheduleId: scheduled ? owners.scheduleId : null,
      scheduledFor: scheduled
        ? new Date(Date.UTC(2026, 0, 1, 0, scheduledCount))
        : null,
      kind: fixture.kind as (typeof taskKindEnum.enumValues)[number],
      prompt: fixture.prompt,
      entrypointJson: fixture.entrypointJson,
      toolCallJson: fixture.toolCallJson,
      resultSchemaJson: fixture.resultSchemaJson,
      inputJson: fixture.inputJson,
      retryJson: fixture.retryJson,
      environmentSelectionJson: fixture.environmentSelectionJson,
      grants: fixture.grantsJson,
      heldWorkItemChangesJson: fixture.heldWorkItemChangesJson,
      resultJson: fixture.resultJson,
      errorJson: fixture.errorJson,
      status: fixture.status as TaskStatus,
      schemaVersion: fixture.schemaVersion,
    });
  return id;
};
