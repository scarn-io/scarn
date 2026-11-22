import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemEventsPort } from "./work-item-events-port";

/**
 * A `WorkItemEventsPort` that holds every event until `flush`, so a batch of
 * changes (an agent run's `applyWorkItemChanges`) tells the listener only
 * once they have all landed, and the listener sees their final state.
 *
 * `flush` delivers, in this order: `created` (one call, every created id in
 * the order created), each `labelsAdded` in the order written, `closed` (one
 * call), then `mayHaveBecomeReady` (one call, deduplicated) — readiness
 * last, so a child created with `blockedBy` is already blocked.
 */
export class DeferredWorkItemEvents implements WorkItemEventsPort {
  private readonly createdIds: UuidV7[] = [];
  private readonly labelWrites: { workItemId: UuidV7; labels: string[] }[] = [];
  private readonly closedIds: UuidV7[] = [];
  private readonly readinessIds: UuidV7[] = [];

  constructor(private readonly target: WorkItemEventsPort) {}

  created(workItemIds: UuidV7[]): Promise<void> {
    this.createdIds.push(...workItemIds);
    return Promise.resolve();
  }

  mayHaveBecomeReady(workItemIds: UuidV7[]): Promise<void> {
    this.readinessIds.push(...workItemIds);
    return Promise.resolve();
  }

  closed(workItemIds: UuidV7[]): Promise<void> {
    this.closedIds.push(...workItemIds);
    return Promise.resolve();
  }

  labelsAdded(workItemId: UuidV7, labels: string[]): Promise<void> {
    this.labelWrites.push({ workItemId, labels });
    return Promise.resolve();
  }

  async flush(tx: DbExecutor): Promise<void> {
    if (this.createdIds.length > 0) {
      await this.target.created(this.createdIds.splice(0), tx);
    }
    for (const write of this.labelWrites.splice(0)) {
      await this.target.labelsAdded(write.workItemId, write.labels, tx);
    }
    if (this.closedIds.length > 0) {
      await this.target.closed(this.closedIds.splice(0), tx);
    }
    if (this.readinessIds.length > 0) {
      await this.target.mayHaveBecomeReady(
        [...new Set(this.readinessIds.splice(0))],
        tx,
      );
    }
  }
}
