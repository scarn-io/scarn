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
 * A Task a schedule started belongs to the schedule's group instead: every
 * Task the schedule started, limited by the schedule rule's `concurrency`.
 * Its step's own per-work-item `concurrency` doesn't apply to it, and it
 * doesn't count against that step's group on any work item.
 *
 * Arrivals and promotions take the group's advisory lock
 * (`TaskRepo.lockConcurrencyGroup`) for the rest of their transaction, so
 * two of them in parallel take turns and see each other's Tasks.
 */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { AutomationScheduleRepo } from "@scarn/core/pipeline-definitions/automation/application/automation-schedule-repo";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { StepConcurrency } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { TaskEntity } from "../domain/task-entity";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";
import {
  isScheduleConcurrencyGroup,
  type ConcurrencyGroupKey,
  type ScheduleConcurrencyGroupKey,
  type StepConcurrencyGroupKey,
  type TaskRepo,
} from "./task-repo";

export const CONCURRENCY_GROUP_FULL = "Scarn.ConcurrencyGroupFull";

/** Where a Task that arrives at its group goes. */
export type Arrival =
  | { decision: "admit" }
  | { decision: "wait" }
  /** `heldBy` are the Tasks holding the group's places, oldest first. */
  | { decision: "drop"; heldBy: UuidV7[] };

/** A Task's group and the limit its step version or schedule sets; null skips the group. */
export type TaskGroupArrival = ConcurrencyGroupKey & {
  concurrency: StepConcurrency | null;
};

/** Which group was full: a step key on a work item, or a schedule. */
export type FullConcurrencyGroup =
  | Pick<StepConcurrencyGroupKey, "stepKey">
  | Pick<ScheduleConcurrencyGroupKey, "scheduleId">;

/** A new Task was dropped because its concurrency group is full (409). */
export class ConcurrencyGroupFullError extends CoreError {
  readonly heldBy: UuidV7[];

  constructor(group: FullConcurrencyGroup, heldBy: readonly UuidV7[]) {
    const held = `it is held by Task${heldBy.length === 1 ? "" : "s"} ${heldBy.join(", ")}`;
    super({
      code: CONCURRENCY_GROUP_FULL,
      ...("scheduleId" in group
        ? {
            message: `The concurrency group of schedule ${group.scheduleId} is full; ${held}`,
            meta: { scheduleId: group.scheduleId, heldBy: [...heldBy] },
          }
        : {
            message: `The concurrency group of step "${group.stepKey}" on this work item is full; ${held}`,
            meta: { stepKey: group.stepKey, heldBy: [...heldBy] },
          }),
      status: 409,
    });
    this.heldBy = [...heldBy];
  }
}

/** A Task's group and the limit to apply to it; null when it has none. */
type ResolvedGroup = {
  key: ConcurrencyGroupKey;
  concurrency: StepConcurrency | null;
};

export type TaskGroupDeps = {
  taskRepo: TaskRepo;
  taskRunRepo: Pick<TaskRunRepo, "create">;
  stepDefinitionRepo: Pick<
    StepDefinitionRepo,
    "load" | "listLatestActiveByKeys"
  >;
  automationScheduleRepo: Pick<AutomationScheduleRepo, "load">;
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
    const group = await this.reacquiredGroup(task, tx);
    if (group === null || group.concurrency === null) {
      return;
    }
    await this.deps.taskRepo.lockConcurrencyGroup(group.key, tx);
    const live = await this.deps.taskRepo.listLiveInConcurrencyGroup(
      group.key,
      tx,
    );
    const holding = live.filter(
      (each) => each.id !== task.id && !isSlotWaiting(each),
    );
    if (holding.length >= group.concurrency.max) {
      throw new ConcurrencyGroupFullError(
        group.key,
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
   * A schedule's limit is the schedule's. A pipeline visit's Task starts from
   * its visit's base branch and, as on arrival, doesn't wait for the work
   * item's blockers; a scheduled Task has no work item to wait for.
   */
  async ended(task: TaskEntity, tx: DbExecutor): Promise<void> {
    const resolved = await this.endedGroup(task, tx);
    if (resolved === null) {
      return;
    }
    const { key: group, concurrency } = resolved;
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
      !isScheduleConcurrencyGroup(group) &&
      (
        await this.deps.workItemBlockRepo.listIdsWithOpenBlockers(
          [group.workItemId],
          tx,
        )
      ).length > 0;
    const now = this.deps.timeProvider.now();
    for (const each of promoted) {
      const visit = isScheduleConcurrencyGroup(group)
        ? null
        : await this.deps.taskPipelineRun.findVisitBaseBranch(each.id, tx);
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

  /**
   * The schedule group of a Task a schedule started, with the schedule's
   * last concurrency even once it's removed, so its open Tasks still finish
   * and its waiting ones are still promoted.
   */
  private async scheduleGroup(
    task: TaskEntity,
    scheduleId: UuidV7,
    tx: DbExecutor,
  ): Promise<ResolvedGroup | null> {
    const schedule = await this.deps.automationScheduleRepo.load(
      scheduleId,
      tx,
    );
    if (!schedule) {
      return null;
    }
    return {
      key: { projectId: task.projectId, scheduleId },
      concurrency: schedule.concurrency,
    };
  }

  /** The group an ended Task reacquires a place in: its own step version's limit. */
  private async reacquiredGroup(
    task: TaskEntity,
    tx: DbExecutor,
  ): Promise<ResolvedGroup | null> {
    if (task.startedByScheduleId !== null) {
      return await this.scheduleGroup(task, task.startedByScheduleId, tx);
    }
    const { workItemId } = task;
    if (task.stepDefinitionId === null || workItemId === null) {
      return null;
    }
    const step = await this.deps.stepDefinitionRepo.load(
      task.stepDefinitionId,
      tx,
    );
    if (!step) {
      return null;
    }
    return {
      key: { projectId: task.projectId, workItemId, stepKey: step.key },
      concurrency: step.concurrency,
    };
  }

  /**
   * The group an ended Task frees a place in, and the limit to promote
   * under; null when neither the latest nor the Task's own version set one.
   */
  private async endedGroup(
    task: TaskEntity,
    tx: DbExecutor,
  ): Promise<ResolvedGroup | null> {
    if (task.startedByScheduleId !== null) {
      return await this.scheduleGroup(task, task.startedByScheduleId, tx);
    }
    const { workItemId } = task;
    if (task.stepDefinitionId === null || workItemId === null) {
      return null;
    }
    const own = await this.deps.stepDefinitionRepo.load(
      task.stepDefinitionId,
      tx,
    );
    if (!own) {
      return null;
    }
    const [latest] = await this.deps.stepDefinitionRepo.listLatestActiveByKeys(
      task.projectId,
      [own.key],
      tx,
    );
    const concurrency = latest ? latest.concurrency : own.concurrency;
    if (concurrency === null && own.concurrency === null) {
      return null;
    }
    return {
      key: { projectId: task.projectId, stepKey: own.key, workItemId },
      concurrency,
    };
  }
}
