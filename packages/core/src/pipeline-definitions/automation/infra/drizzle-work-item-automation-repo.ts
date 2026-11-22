import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { automations, workItemAutomations } from "@scarn/core/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  parseWorkItemId,
  type WorkItemId,
} from "@scarn/core/work-items/work-item/domain/work-item-id";
import type {
  ResolvedWorkItemAutomation,
  WorkItemAutomationRepo,
} from "../application/work-item-automation-repo";
import { WorkItemAutomationEntity } from "../domain/work-item-automation-entity";
import { resolveAutomations } from "./drizzle-automation-repo";

type AttachmentRow = typeof workItemAutomations.$inferSelect;

const rowToEntity = (row: AttachmentRow): WorkItemAutomationEntity =>
  WorkItemAutomationEntity.rehydrate({
    workItemId: parseWorkItemId(row.workItemId),
    automationId: parseUuidV7(row.automationId),
    attachedByUserId: parseUuidV7(row.attachedByUserId),
    attachedAt: row.attachedAt,
  });

const byIds = (workItemId: WorkItemId, automationId: UuidV7) =>
  and(
    eq(workItemAutomations.workItemId, workItemId),
    eq(workItemAutomations.automationId, automationId),
  );

export class DrizzleWorkItemAutomationRepo implements WorkItemAutomationRepo {
  async load(
    workItemId: WorkItemId,
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemAutomationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(workItemAutomations)
      .where(byIds(workItemId, automationId))
      .limit(1);
    return row ? rowToEntity(row) : null;
  }

  async listByWorkItemId(
    workItemId: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedWorkItemAutomation[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ attachment: workItemAutomations, automation: automations })
      .from(workItemAutomations)
      .innerJoin(
        automations,
        eq(automations.id, workItemAutomations.automationId),
      )
      .where(eq(workItemAutomations.workItemId, workItemId))
      .orderBy(asc(automations.key));
    const resolved = await resolveAutomations(
      rows.map((row) => row.automation),
      db,
    );
    return rows.flatMap((row, index) => {
      const entry = resolved[index];
      return entry
        ? [{ ...entry, attachment: rowToEntity(row.attachment) }]
        : [];
    });
  }

  async insert(
    attachment: WorkItemAutomationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemAutomationEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(workItemAutomations)
      .values({
        workItemId: attachment.workItemId,
        automationId: attachment.automationId,
        attachedByUserId: attachment.attachedByUserId,
        attachedAt: attachment.attachedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      return rowToEntity(row);
    }
    return (
      (await this.load(attachment.workItemId, attachment.automationId, db)) ??
      attachment
    );
  }

  async delete(
    workItemId: WorkItemId,
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<boolean> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(workItemAutomations)
      .where(byIds(workItemId, automationId))
      .returning({ workItemId: workItemAutomations.workItemId });
    return rows.length > 0;
  }
}
