import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  startReadyWork,
  type StartReadyWorkDeps,
} from "@scarn/core/tasks/task/application/start-ready-work";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { noopLogger } from "@scarn/observability/logging";
import type { AutomationEntity } from "../domain/automation-entity";
import {
  MAX_AUTOMATION_DEPTH,
  runAutomation,
  type AutomationDispatchDeps,
} from "./automation-dispatch";
import type { WorkItemEventContext } from "./automation-event-context";

export type AutomationRunnerDeps = StartReadyWorkDeps &
  AutomationDispatchDeps & {
    workItemRepo: Pick<WorkItemRepo, "load" | "loadMany">;
  };

/** Fires `self.attached` for a new attachment (see `attachWorkItemAutomation`). */
export type SelfAttachedPort = {
  selfAttached(
    workItem: WorkItemEntity,
    automation: AutomationEntity,
    tx: DbExecutor,
  ): Promise<void>;
};

/**
 * Listens to work item events (behind `WorkItemEventsPort`) and runs the
 * automations they match, in the transaction of the change that raised them.
 *
 * - An event on a child work item (`child.*`) runs the automations attached
 *   to its parent, unless the parent is closed.
 * - An event on a top-level work item (`workItem.*`) runs the project's
 *   enabled project automations, in key order.
 * - `self.attached` runs only the automation just attached.
 *
 * Readiness first queues the next run of every `waiting_for_work` Task on a
 * now-ready item (`startReadyWork`), then fires `ready` for the items that
 * are open with no open blockers. See `runAutomation` for rules, routes,
 * failure isolation and the activity lines.
 */
export class AutomationRunner implements WorkItemEventsPort, SelfAttachedPort {
  constructor(private readonly deps: AutomationRunnerDeps) {}

  async created(workItemIds: UuidV7[], tx: DbExecutor): Promise<void> {
    for (const workItem of await this.load(workItemIds, tx)) {
      await this.fireAbout(workItem, "created", null, tx);
    }
  }

  async mayHaveBecomeReady(
    workItemIds: UuidV7[],
    tx: DbExecutor,
  ): Promise<void> {
    await startReadyWork(workItemIds, this.deps, tx);
    const open = (await this.load(workItemIds, tx)).filter(
      (workItem) => workItem.state === "open",
    );
    if (open.length === 0) {
      return;
    }
    const blocked = new Set<string>(
      await this.deps.workItemBlockRepo.listIdsWithOpenBlockers(
        open.map((workItem) => parseUuidV7(workItem.id)),
        tx,
      ),
    );
    for (const workItem of open) {
      if (!blocked.has(workItem.id)) {
        await this.fireAbout(workItem, "ready", null, tx);
      }
    }
  }

  async closed(workItemIds: UuidV7[], tx: DbExecutor): Promise<void> {
    for (const workItem of await this.load(workItemIds, tx)) {
      if (workItem.parentWorkItemId !== null) {
        await this.fireAbout(workItem, "closed", null, tx);
      }
    }
  }

  async labelsAdded(
    workItemId: UuidV7,
    labels: string[],
    tx: DbExecutor,
  ): Promise<void> {
    const [workItem] = await this.load([workItemId], tx);
    if (!workItem || workItem.parentWorkItemId !== null) {
      return;
    }
    for (const label of labels) {
      await this.fireAbout(workItem, "label.added", label, tx);
    }
  }

  async selfAttached(
    workItem: WorkItemEntity,
    automation: AutomationEntity,
    tx: DbExecutor,
  ): Promise<void> {
    await this.runSelfAttached(workItem, automation, 0, tx);
  }

  private async runSelfAttached(
    workItem: WorkItemEntity,
    automation: AutomationEntity,
    depth: number,
    tx: DbExecutor,
  ): Promise<void> {
    if (depth >= MAX_AUTOMATION_DEPTH) {
      (this.deps.logger ?? noopLogger).warn(
        { automation: automation.key, workItemId: workItem.id, depth },
        "Automation depth limit reached; self.attached not fired",
      );
      return;
    }
    const latestVersion = await this.deps.automationRepo.loadLatestVersion(
      automation.id,
      tx,
    );
    await this.run(
      [{ automation, latestVersion }],
      { event: "self.attached", workItem, child: null, label: null },
      depth,
      tx,
    );
  }

  /**
   * Fires the event about `workItem`: `child.<kind>` to its parent's
   * attachments when it has a parent, else `workItem.<kind>` to the
   * project automations. `child.closed` has no project counterpart.
   */
  private async fireAbout(
    workItem: WorkItemEntity,
    kind: "created" | "ready" | "closed" | "label.added",
    label: string | null,
    tx: DbExecutor,
  ): Promise<void> {
    if (workItem.parentWorkItemId === null) {
      if (kind === "closed") {
        return;
      }
      const automations =
        await this.deps.automationRepo.listEnabledProjectAutomations(
          workItem.projectId,
          tx,
        );
      await this.run(
        automations,
        { event: `workItem.${kind}`, workItem, child: null, label },
        0,
        tx,
      );
      return;
    }
    if (kind === "label.added") {
      return;
    }
    const parent = await this.deps.workItemRepo.load(
      workItem.parentWorkItemId,
      tx,
    );
    if (!parent || parent.state === "closed") {
      return;
    }
    const attachments = await this.deps.workItemAutomationRepo.listByWorkItemId(
      parent.id,
      tx,
    );
    await this.run(
      attachments,
      {
        event: `child.${kind}`,
        workItem: parent,
        child: workItem,
        label: null,
      },
      0,
      tx,
    );
  }

  private async run(
    automations: Parameters<typeof runAutomation>[0][],
    context: WorkItemEventContext,
    depth: number,
    tx: DbExecutor,
  ): Promise<void> {
    for (const automation of automations) {
      await runAutomation(
        automation,
        context,
        depth,
        async (attached, nextDepth, attachTx) => {
          await this.runSelfAttached(
            attached.workItem,
            attached.automation,
            nextDepth,
            attachTx,
          );
        },
        this.deps,
        tx,
      );
    }
  }

  private async load(
    workItemIds: UuidV7[],
    tx: DbExecutor,
  ): Promise<WorkItemEntity[]> {
    if (workItemIds.length === 0) {
      return [];
    }
    const loaded = await this.deps.workItemRepo.loadMany(
      workItemIds.map(parseWorkItemId),
      tx,
    );
    const byId = new Map(loaded.map((workItem) => [workItem.id, workItem]));
    return workItemIds.flatMap((id) => {
      const workItem = byId.get(parseWorkItemId(id));
      return workItem ? [workItem] : [];
    });
  }
}
