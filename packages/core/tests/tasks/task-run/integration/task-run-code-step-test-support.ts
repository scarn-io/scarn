import { expect } from "bun:test";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { automations, taskRuns } from "@/lib/db/schema";
import { AutomationScheduleEntity } from "@/pipeline-definitions/automation/domain/automation-schedule-entity";
import { WORK_ITEM_GRANT_MISSING } from "@/tasks/task-run/application/code-step-work-item-access";
import type { Grant } from "@/tasks/task/domain/grants";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { Claim } from "./task-run-create-work-item-test-support";

export const CODE_STEP_NOW = new Date("2026-11-02T12:00:00.000Z");

export const projectGrant = (
  action: "read" | "create" | "update",
  extra: { keyPrefix?: string; labels?: string[] } = {},
): Grant =>
  ({ resource: "workItem", action, scope: "project", ...extra }) as Grant;

/** Read, create (label `imported`) and update on `project`, under `keyPrefix` if given. */
export const importGrants = (keyPrefix?: string): Grant[] => [
  projectGrant("read"),
  projectGrant("create", {
    labels: ["imported"],
    ...(keyPrefix ? { keyPrefix } : {}),
  }),
  projectGrant("update", keyPrefix ? { keyPrefix } : {}),
];

export type ImportItem = {
  platform: "custom" | "jira" | "github";
  platformKey: string;
  title: string;
  description: string;
  sourceUpdatedAt: string;
  state?: "open" | "closed";
  labels?: string[];
};

export const importItem = (
  platformKey: string,
  sourceUpdatedAt: string,
  extra: Partial<ImportItem> = {},
): ImportItem => ({
  platform: "custom",
  platformKey,
  title: `Ticket ${platformKey}`,
  description: "Imported from the source.",
  sourceUpdatedAt,
  ...extra,
});

/** A fresh `platformKey` prefix, so concurrent tests don't share keys. */
export const keyPrefix = () => `src-${crypto.randomUUID()}/`;

export const expectGrantMissing = (
  response: { error: { status: unknown; value: unknown } | null },
  detail?: string,
) => {
  expect(response.error?.status).toBe(422);
  const value = response.error?.value as
    { code?: string; detail?: string } | undefined;
  expect(value?.code).toBe(WORK_ITEM_GRANT_MISSING);
  if (detail) {
    expect(value?.detail).toContain(detail);
  }
};

const seedSchedule = async (appContext: AppContext, projectId: UuidV7) => {
  const automationId = createUuidV7();
  await getDb()
    .insert(automations)
    .values({
      id: automationId,
      projectId,
      key: `scheduled-${crypto.randomUUID()}`,
      scope: "project",
      enabled: true,
    });
  const schedule = await appContext.automationScheduleRepo.insert(
    AutomationScheduleEntity.create(
      automationId,
      {
        key: "import",
        cron: "*/15 * * * *",
        timezone: "UTC",
        concurrency: { max: 1, waiting: 0 },
      },
      CODE_STEP_NOW,
    ),
  );
  return schedule.id;
};

/** A running run of a scheduled Task with `grants`, claimed by `claimedByUserId`. */
export const startClaimedScheduledRun = async (
  appContext: AppContext,
  input: {
    projectId: UuidV7;
    claimedByUserId: UuidV7;
    grants: Grant[];
    kind?: "code" | "agent";
  },
): Promise<Claim & { taskId: UuidV7 }> => {
  const kind = input.kind ?? "code";
  const task = await appContext.taskRepo.create(
    TaskEntity.create({
      projectId: input.projectId,
      kind,
      ...(kind === "code"
        ? { entrypointJson: { sourceFile: "steps/import.ts" } }
        : { prompt: "Import." }),
      status: "running",
      grants: input.grants,
      createdAt: CODE_STEP_NOW,
      workItemId: null,
      startedByScheduleId: await seedSchedule(appContext, input.projectId),
      scheduledFor: CODE_STEP_NOW,
    }),
  );
  const runId = createUuidV7();
  const claimToken = `claim-${crypto.randomUUID()}`;
  await getDb()
    .insert(taskRuns)
    .values({
      id: runId,
      taskId: task.id,
      number: 1,
      reason: "initial",
      projectId: input.projectId,
      workItemId: null,
      status: "running",
      claimedBy: "code-step-work-items",
      claimedByUserId: input.claimedByUserId,
      claimToken,
      claimedAt: CODE_STEP_NOW,
      lastHeartbeatAt: CODE_STEP_NOW,
      leaseExpiresAt: new Date(CODE_STEP_NOW.getTime() + 60_000),
      startedAt: CODE_STEP_NOW,
    });
  return { task: { id: runId }, claimToken, taskId: task.id };
};
