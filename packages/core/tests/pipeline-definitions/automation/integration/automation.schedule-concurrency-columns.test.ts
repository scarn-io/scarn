/**
 * `automation_schedules` keeps a schedule's concurrency in `concurrency_max`
 * and `concurrency_waiting`. Rows are written directly to stand in for rows
 * written by older code.
 */
import { beforeAll, describe, expect } from "bun:test";
import { getDb } from "@/lib/db";
import { automationSchedules } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { AutomationEntity } from "@/pipeline-definitions/automation/domain/automation-entity";
import { DrizzleAutomationRepo } from "@/pipeline-definitions/automation/infra/drizzle-automation-repo";
import { DrizzleAutomationScheduleRepo } from "@/pipeline-definitions/automation/infra/drizzle-automation-schedule-repo";
import { serialTest } from "tests/utils";
import { createAutomationFixture } from "./automation-test-support";

const automationRepo = new DrizzleAutomationRepo();
const scheduleRepo = new DrizzleAutomationScheduleRepo();

describe("automation schedule concurrency columns", () => {
  let automationId: UuidV7;

  beforeAll(async () => {
    const { projectId } = await createAutomationFixture("schedule-columns");
    const automation = AutomationEntity.create({
      projectId,
      key: "schedule-columns",
      title: null,
      scope: "project",
    });
    await automationRepo.insert(automation);
    automationId = automation.id;
  });

  serialTest("reads concurrency from the columns", async () => {
    const id = createUuidV7();
    await getDb()
      .insert(automationSchedules)
      .values({
        id,
        automationId,
        key: "columns",
        cron: "0 * * * *",
        timezone: "UTC",
        concurrencyMax: 4,
        concurrencyWaiting: 3,
        nextRunAt: new Date("2030-01-01T00:00:00.000Z"),
        removedAt: new Date(),
      });
    const schedule = await scheduleRepo.load(id);
    expect(schedule?.concurrency).toEqual({ max: 4, waiting: 3 });
  });
});
