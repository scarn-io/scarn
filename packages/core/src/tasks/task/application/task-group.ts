/**
 * Concurrency groups. A step with `concurrency: { max, waiting }` lets at
 * most `max` of its Tasks hold a place on one work item, and up to `waiting`
 * more wait for one (`waiting_for_concurrency_slot`); a Task past both is
 * dropped and never created. The group is the step key on the work item, so
 * every version of the step, and every way its Tasks were started (`POST
 * /tasks`, default assignment, an automation, a pipeline visit), share it.
 *
 * Every Task of the group that hasn't ended holds a place, including one
 * waiting for a person or for its work item's blockers: it's still live and
 * will run again. Automatic retries and continuations keep that place;
 * a person's retry of an ended Task must reacquire it.
 * Steps without `concurrency`, and prompt Tasks (no step definition), skip
 * the group.
 *
 * Arrivals and promotions take the group's advisory lock
 * (`TaskRepo.lockConcurrencyGroup`) for the rest of their transaction, so
 * two of them in parallel take turns and see each other's Tasks.
 */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { StepConcurrency } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { TaskEntity } from "../domain/task-entity";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";
import type { ConcurrencyGroupKey, TaskRepo } from "./task-repo";

export const CONCURRENCY_GROUP_FULL = "Scarn.ConcurrencyGroupFull";

/** Where a Task that arrives at its group goes. */
export type Arrival =
  | { decision: "admit" }
  | { decision: "wait" }
  /** `heldBy` are the Tasks holding the group's places, oldest first. */
  | { decision: "drop"; heldBy: UuidV7[] };

/** A Task's group and the limit its step version sets; null skips the group. */
export type TaskGroupArrival = ConcurrencyGroupKey & {
  concurrency: StepConcurrency | null;
};

/** A new Task was dropped because its concurrency group is full (409). */
export class ConcurrencyGroupFullError extends CoreError {
  readonly heldBy: UuidV7[];

  constructor(stepKey: string, heldBy: readonly UuidV7[]) {
    super({
      code: CONCURRENCY_GROUP_FULL,
      message: `The concurrency group of step "${stepKey}" on this work item is full; it is held by Task${heldBy.length === 1 ? "" : "s"} ${heldBy.join(", ")}`,
      status: 409,
      meta: { stepKey, heldBy: [...heldBy] },
    });
    this.heldBy = [...heldBy];
  }
}

export type TaskGroupDeps = {
  taskRepo: TaskRepo;
  taskRunRepo: Pick<TaskRunRepo, "create">;
  stepDefinitionRepo: Pick<
    StepDefinitionRepo,
    "load" | "listLatestActiveByKeys"
  >;
  workItemBlockRepo: Pick<WorkItemBlockRepo, "listIdsWithOpenBlockers">;
  taskPipelineRun: Pick<TaskPipelineRunPort, "findVisitBaseBranch">;
  timeProvider: TimeProvider;
  workNotifier: WorkNotifier;
};

const isSlotWaiting = (task: TaskEntity): boolean =>
  task.status === "waiting_for_concurrency_slot";

export class TaskGroup {
  constructor(private readonly deps: TaskGroupDeps) {}

  /** An ended Task reacquires a place, never joining the waiting queue. */
  async reacquire(task: TaskEntity, tx: DbExecutor): Promise<void> {
    const { workItemId } = task;
    if (task.stepDefinitionId === null || workItemId === null) {
      return;
    }
    const step = await this.deps.stepDefinitionRepo.load(
      task.stepDefinitionId,
      tx,
    );
    if (!step || step.concurrency === null) {
      return;
    }
    const group = {
      projectId: task.projectId,
      workItemId,
      stepKey: step.key,
    };
    await this.deps.taskRepo.lockConcurrencyGroup(group, tx);
    const live = await this.deps.taskRepo.listLiveInConcurrencyGroup(group, tx);
    const holding = live.filter(
      (each) => each.id !== task.id && !isSlotWaiting(each),
    );
    if (holding.length >= step.concurrency.max) {
      throw new ConcurrencyGroupFullError(
        step.key,
        holding.map((each) => each.id),
      );
    }
  }

  /**
   * Decides, under the group's lock, whether a new Task of the group is let
   * in (`admit`), waits for a place (`wait`) or is dropped (`drop`). The
   * caller creates the Task in the same transaction, so the lock covers it.
   */
  async arrive(arrival: TaskGroupArrival, tx: DbExecutor): Promise<Arrival> {
    const { concurrency } = arrival;
    if (concurrency === null) {
      return { decision: "admit" };
    }
    await this.deps.taskRepo.lockConcurrencyGroup(arrival, tx);
    const live = await this.deps.taskRepo.listLiveInConcurrencyGroup(
      arrival,
      tx,
    );
    const holding = live.filter((task) => !isSlotWaiting(task));
    if (holding.length < concurrency.max) {
      return { decision: "admit" };
    }
    if (live.length - holding.length < concurrency.waiting) {
      return { decision: "wait" };
    }
    return { decision: "drop", heldBy: holding.map((task) => task.id) };
  }

  /**
   * `task` ended (or was cancelled while it waited): under the group's lock,
   * admits the oldest waiting Tasks into the places now free (`admit`). The
   * limit is the latest active version's of the step key, else the ended
   * Task's version's; with no limit left every waiting Task is admitted.
   * A pipeline visit's Task starts from its visit's base branch and, as on
   * arrival, doesn't wait for the work item's blockers.
   */
  async ended(task: TaskEntity, tx: DbExecutor): Promise<void> {
    const { workItemId } = task;
    if (task.stepDefinitionId === null || workItemId === null) {
      return;
    }
    const own = await this.deps.stepDefinitionRepo.load(
      task.stepDefinitionId,
      tx,
    );
    if (!own) {
      return;
    }
    const [latest] = await this.deps.stepDefinitionRepo.listLatestActiveByKeys(
      task.projectId,
      [own.key],
      tx,
    );
    const concurrency = latest ? latest.concurrency : own.concurrency;
    if (concurrency === null && own.concurrency === null) {
      return;
    }
    const group: ConcurrencyGroupKey = {
      projectId: task.projectId,
      stepKey: own.key,
      workItemId,
    };
    await this.deps.taskRepo.lockConcurrencyGroup(group, tx);
    const live = await this.deps.taskRepo.listLiveInConcurrencyGroup(group, tx);
    const holding = live.filter((each) => !isSlotWaiting(each)).length;
    const free =
      concurrency === null ? Infinity : Math.max(0, concurrency.max - holding);
    if (free === 0) {
      return;
    }
    const waiting = await this.deps.taskRepo.lockWaitingInConcurrencyGroup(
      group,
      tx,
    );
    const promoted = waiting.slice(0, free);
    if (promoted.length === 0) {
      return;
    }
    const blocked =
      (
        await this.deps.workItemBlockRepo.listIdsWithOpenBlockers(
          [workItemId],
          tx,
        )
      ).length > 0;
    const now = this.deps.timeProvider.now();
    for (const each of promoted) {
      const visit = await this.deps.taskPipelineRun.findVisitBaseBranch(
        each.id,
        tx,
      );
      const admitted = each.admit({
        blocked: visit === null && blocked,
        baseBranch: visit?.baseBranch ?? null,
        now,
      });
      await this.deps.taskRepo.save(admitted.task, tx);
      if (admitted.run) {
        const run = await this.deps.taskRunRepo.create(admitted.run, tx);
        this.deps.workNotifier.enqueued(run.projectId);
      }
    }
  }
}
