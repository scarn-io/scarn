import { eq, inArray } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { createAppContext } from "@/lib/di";
import type { DbExecutor } from "@/lib/db/db-executor";
import { workItemBlocks, workItems } from "@/lib/db/schema";

type WorkItemEventsPort = ReturnType<
  NonNullable<
    NonNullable<Parameters<typeof createAppContext>[0]>["workItemEvents"]
  >
>;

/**
 * One call on the port, with what the transaction showed at that moment:
 * the item's labels and how many items block it (open or not).
 */
export type RecordedWorkItemEvent =
  | {
      event: "created" | "mayHaveBecomeReady" | "closed";
      workItemIds: UuidV7[];
      blockerCounts: Record<string, number>;
    }
  | {
      event: "labelsAdded";
      workItemId: UuidV7;
      labels: string[];
      labelsOnItem: string[];
    };

const countBlockers = async (
  workItemIds: UuidV7[],
  tx: DbExecutor,
): Promise<Record<string, number>> => {
  const counts: Record<string, number> = Object.fromEntries(
    workItemIds.map((id) => [id, 0]),
  );
  if (workItemIds.length === 0) {
    return counts;
  }
  const rows = await tx
    .select({ blocked: workItemBlocks.blockedWorkItemId })
    .from(workItemBlocks)
    .where(inArray(workItemBlocks.blockedWorkItemId, workItemIds));
  for (const row of rows) {
    counts[row.blocked] = (counts[row.blocked] ?? 0) + 1;
  }
  return counts;
};

/**
 * Wraps the real `AutomationRunner` (so `startReadyWork` still runs) and
 * records every call, in order.
 */
export class RecordingWorkItemEvents implements WorkItemEventsPort {
  readonly events: RecordedWorkItemEvent[] = [];

  constructor(private readonly inner: WorkItemEventsPort) {}

  async created(workItemIds: UuidV7[], tx: DbExecutor): Promise<void> {
    await this.recordIds("created", workItemIds, tx);
    await this.inner.created(workItemIds, tx);
  }

  async mayHaveBecomeReady(
    workItemIds: UuidV7[],
    tx: DbExecutor,
  ): Promise<void> {
    await this.recordIds("mayHaveBecomeReady", workItemIds, tx);
    await this.inner.mayHaveBecomeReady(workItemIds, tx);
  }

  async closed(workItemIds: UuidV7[], tx: DbExecutor): Promise<void> {
    await this.recordIds("closed", workItemIds, tx);
    await this.inner.closed(workItemIds, tx);
  }

  async labelsAdded(
    workItemId: UuidV7,
    labels: string[],
    tx: DbExecutor,
  ): Promise<void> {
    const [row] = await tx
      .select({ labels: workItems.labels })
      .from(workItems)
      .where(eq(workItems.id, workItemId));
    this.events.push({
      event: "labelsAdded",
      workItemId,
      labels,
      labelsOnItem: [...(row?.labels ?? [])],
    });
    await this.inner.labelsAdded(workItemId, labels, tx);
  }

  /** The recorded events that mention any of `ids`, in order. */
  about(ids: string[]): RecordedWorkItemEvent[] {
    const wanted = new Set(ids);
    return this.events.filter((each) =>
      each.event === "labelsAdded"
        ? wanted.has(each.workItemId)
        : each.workItemIds.some((id) => wanted.has(id)),
    );
  }

  private async recordIds(
    event: "created" | "mayHaveBecomeReady" | "closed",
    workItemIds: UuidV7[],
    tx: DbExecutor,
  ): Promise<void> {
    this.events.push({
      event,
      workItemIds: [...workItemIds],
      blockerCounts: await countBlockers(workItemIds, tx),
    });
  }
}
