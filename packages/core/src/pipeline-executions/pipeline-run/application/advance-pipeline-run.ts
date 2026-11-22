/* eslint-disable max-lines */
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ManagedLaunchRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-launch-repo";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineGraphVersionRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-version-repo";
import type { PipelineGraphVersionEntity } from "@scarn/core/pipeline-definitions/pipeline-graph/domain/pipeline-graph-version-entity";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { StepDefinitionEntity } from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import { buildTaskInstructionsFromStepDefinition } from "@scarn/core/pipeline-definitions/step-definition/domain/build-task-instructions-from-step-definition";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import {
  onRunEnded,
  syncTaskWithRun,
} from "@scarn/core/tasks/task/application/on-run-ended";
import { noopTaskOutcomePort } from "@scarn/core/tasks/task/application/task-outcome-port";
import { onTaskEnded } from "@scarn/core/tasks/task/application/on-task-ended";
import {
  ConcurrencyGroupFullError,
  type TaskGroup,
} from "@scarn/core/tasks/task/application/task-group";
import { TaskEntity } from "@scarn/core/tasks/task/domain/task-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { TaskMessageRepo } from "@scarn/core/tasks/task-message/application/task-message-repo";
import { TaskMessageEntity } from "@scarn/core/tasks/task-message/domain/task-message-entity";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import {
  notifyWaitingForPerson,
  type NotifyWaitingForPersonDeps,
  type WaitingSubject,
} from "@scarn/core/notifications/user-notification/application/notify-waiting-for-person";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { loadWorkItemWaitingOnUserIds } from "@scarn/core/work-items/work-item/application/load-work-item-waiting-on";
import { WorkItemCommentEntity } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-entity";
import { parseWorkItemCommentId } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-id";
import { DEFAULT_MAX_TURNS } from "@scarn/sdk/contracts/pipeline-document";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { decide } from "../domain/engine/decide";
import {
  DecideError,
  ENGINE_ERRORS,
  type Command,
  type EngineError,
  type EngineEvent,
  type Ignored,
  type QueuedTask,
  type RunState,
  type TaskInfo,
  type VisitStatus,
} from "../domain/engine/types";
import type { PipelineRunEntity } from "../domain/pipeline-run-entity";
import { NodeVisitEntity } from "../domain/node-visit-entity";
import {
  detectRunCompletion,
  type RunCompletion,
} from "../domain/run-completion";
import type { NodeVisitQuestionRepo } from "./node-visit-question-repo";
import type { PipelineRunHistory, PipelineRunRepo } from "./pipeline-run-repo";

export type AdvancePipelineRunDeps = {
  workItemCommentRepo: WorkItemCommentRepo;
  nodeVisitQuestionRepo: NodeVisitQuestionRepo;
  pipelineRunRepo: PipelineRunRepo;
  pipelineGraphVersionRepo: PipelineGraphVersionRepo;
  stepDefinitionRepo: StepDefinitionRepo;
  taskRepo: TaskRepo;
  taskRunRepo: TaskRunRepo;
  taskMessageRepo: TaskMessageRepo;
  conversationRepo: ConversationRepo;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  taskGroup: Pick<TaskGroup, "arrive" | "ended">;
  notifications: NotifyWaitingForPersonDeps;
  timeProvider: TimeProvider;
  workNotifier: WorkNotifier;
  managedLaunchRepo: Pick<
    ManagedLaunchRepo,
    "closeAllForRun" | "listOperations"
  >;
};

export type AdvanceOutcome = {
  run: PipelineRunEntity;
  /** Set when this advance moved the run from open to terminal. */
  completion: RunCompletion | null;
  /** Why `decide` did nothing, e.g. a late result for a superseded visit. */
  ignored: Ignored | null;
  /** Messages attached to the Tasks this advance queued. */
  messages: TaskMessageEntity[];
  queuedTaskIds: UuidV7[];
  /** Saved agent sessions of the Tasks this advance ended; delete after commit. */
  endedSessionObjectKeys: string[];
};

export type AdvanceError = ResourceNotFoundError | CoreValidationError;

export type AdvanceOptions = {
  /** Quoted text stored with a `rerun_from` message. */
  messageQuoteText?: string | null | undefined;
};

const ENDED_VISIT_STATUSES: ReadonlySet<VisitStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
]);

const toTaskInfo = (task: TaskRunEntity): TaskInfo => ({
  id: task.id,
  status: task.status,
  result: task.resultJson,
  error: task.errorJson,
  workBranch: task.workBranch,
});

export const decideErrorToResult = (
  error: DecideError,
  event: EngineEvent,
): AdvanceError => {
  if (error.code === "unknown_visit") {
    return new ResourceNotFoundError(
      "Node visit",
      "visitId" in event ? event.visitId : "unknown",
    );
  }
  return new CoreValidationError(
    error.message,
    `PIPELINE_RUN_${error.code.toUpperCase()}`,
    error.meta,
  );
};

/**
 * Applies `decide`'s commands, in order, to the tables. Keeps the visits and
 * Tasks it has touched in memory so later commands patch the latest state.
 */
class CommandWriter {
  private readonly visits: Map<string, NodeVisitEntity>;
  private readonly stepDefinitions = new Map<UuidV7, StepDefinitionEntity>();
  private readonly visitTaskEntities = new Map<UuidV7, TaskEntity>();
  public run: PipelineRunEntity;
  public readonly messages: TaskMessageEntity[] = [];
  public readonly queuedTaskIds: UuidV7[] = [];
  public readonly endedSessionObjectKeys = new Set<string>();
  /** Visits whose Task was dropped by a full concurrency group. */
  public readonly droppedVisits: { visitId: string; error: EngineError }[] = [];

  constructor(
    run: PipelineRunEntity,
    private readonly history: PipelineRunHistory,
    private readonly tasks: Map<string, TaskRunEntity>,
    private readonly version: PipelineGraphVersionEntity,
    private readonly workItem: WorkItemEntity | null,
    private readonly now: Date,
    private readonly deps: AdvancePipelineRunDeps,
    private readonly tx: DbExecutor,
    private readonly options: AdvanceOptions,
  ) {
    this.run = run;
    this.visits = new Map(history.visits.map((visit) => [visit.id, visit]));
  }

  /**
   * Visits only end through `updateVisit`. A step visit that ends while its
   * Task waits (for a person or for work) cancels the Task, which ends it
   * (`onTaskEnded`); a Task with a run still open is cancelled by `cancelTask`.
   */
  private async onStepVisitEnded(visit: NodeVisitEntity): Promise<void> {
    if (
      visit.nodeKind !== "step" ||
      !ENDED_VISIT_STATUSES.has(visit.status) ||
      !visit.taskId
    ) {
      return;
    }
    const task = await this.loadVisitTask(visit.taskId);
    const cancelled = task.cancelWaiting(this.now);
    if (cancelled === task) {
      return;
    }
    const ended = await onTaskEnded(
      await this.deps.taskRepo.save(cancelled, this.tx),
      null,
      { ...this.deps, endedTaskSessions: this.endedSessionObjectKeys },
      this.tx,
    );
    this.visitTaskEntities.set(ended.id, ended);
  }

  async apply(command: Command): Promise<void> {
    const { pipelineRunRepo } = this.deps;
    switch (command.type) {
      case "createVisit": {
        const visit = NodeVisitEntity.fromEngineVisit(
          this.run.id,
          command.visit,
        );
        await pipelineRunRepo.insertVisit(visit, this.tx);
        this.visits.set(visit.id, visit);
        return;
      }
      case "updateVisit": {
        const current = this.visits.get(command.visitId);
        if (!current) {
          throw new InvariantViolationError(
            `decide updated visit ${command.visitId}, which isn't in run ${this.run.id}`,
            "PIPELINE_RUN_VISIT_MISSING",
          );
        }
        const updated = current.withPatch(command.patch);
        await pipelineRunRepo.updateVisit(updated, this.tx);
        this.visits.set(updated.id, updated);
        if (command.patch.status !== undefined) {
          await this.onStepVisitEnded(updated);
        }
        return;
      }
      case "createLaneGroup":
        await pipelineRunRepo.insertLaneGroup(
          this.run.id,
          command.group,
          command.lanes,
          this.tx,
        );
        return;
      case "updateLaneGroup":
        await pipelineRunRepo.updateLaneGroup(
          parseUuidV7(command.groupId),
          command.patch,
          this.tx,
        );
        return;
      case "createLane":
        await pipelineRunRepo.insertLane(command.lane, this.tx);
        return;
      case "updateLane":
        await pipelineRunRepo.updateLane(
          parseUuidV7(command.laneId),
          command.patch,
          this.tx,
        );
        return;
      case "queueTask":
        await this.queueTask(command.task);
        return;
      case "cancelTask":
        await this.cancelTask(command.taskId);
        return;
      case "updateRun":
        this.run = this.run.withPatch(command.patch, this.now);
        return;
      case "askQuestion":
        await this.askQuestion(command);
        return;
      case "updateQuestion":
        await this.deps.nodeVisitQuestionRepo.update(
          parseUuidV7(command.questionId),
          command.patch,
          this.tx,
        );
        return;
    }
  }

  private async askQuestion(
    command: Extract<Command, { type: "askQuestion" }>,
  ): Promise<void> {
    await this.deps.workItemCommentRepo.create(
      WorkItemCommentEntity.createAgentQuestion({
        id: parseWorkItemCommentId(command.commentId),
        projectId: this.run.projectId,
        workItemId: this.run.workItemId,
        body: command.body,
        createdAt: this.now,
      }),
      this.tx,
    );
    await this.deps.nodeVisitQuestionRepo.create(
      this.run.id,
      {
        id: command.questionId,
        visitId: command.visitId,
        commentId: command.commentId,
        status: "open",
        answerCommentId: null,
        answeredByUserId: null,
        createdAt: this.now.toISOString(),
        resolvedAt: null,
      },
      this.tx,
    );
    await this.notifyWaiting(
      { questionId: parseUuidV7(command.questionId), source: "system" },
      null,
      command.body,
    );
  }

  /** Tells the work item's assignee, its creator and the run's starter that Scarn waits on them. */
  private async notifyWaiting(
    subject: WaitingSubject,
    taskId: UuidV7 | null,
    body: string,
  ): Promise<void> {
    await notifyWaitingForPerson(
      {
        projectId: this.run.projectId,
        workItemId: this.run.workItemId,
        workItemTitle: this.workItem?.title ?? null,
        pipelineExecutionId: this.run.id,
        taskId,
        body,
        subject,
        recipientUserIds: await loadWorkItemWaitingOnUserIds(
          this.workItem,
          this.run.triggeredByUserId,
          this.deps.workItemRepo,
          this.tx,
        ),
        now: this.now,
      },
      this.deps.notifications,
      this.tx,
    );
  }

  private async stepDefinitionFor(
    stepKey: string,
  ): Promise<StepDefinitionEntity> {
    const id = this.version.stepDefinitionIdFor(stepKey);
    if (!id) {
      throw new InvariantViolationError(
        `Pipeline version ${this.version.id} has no pinned step for "${stepKey}"`,
        "PIPELINE_VERSION_STEP_NOT_PINNED",
      );
    }
    const cached = this.stepDefinitions.get(id);
    if (cached) {
      return cached;
    }
    const loaded = await this.deps.stepDefinitionRepo.load(id, this.tx);
    if (!loaded) {
      throw new InvariantViolationError(
        `Pinned step definition ${id} is missing`,
        "PIPELINE_VERSION_STEP_MISSING",
      );
    }
    this.stepDefinitions.set(id, loaded);
    return loaded;
  }

  private async loadTask(taskId: string): Promise<TaskRunEntity | null> {
    const cached = this.tasks.get(taskId);
    if (cached) {
      return cached;
    }
    const loaded = await this.deps.taskRunRepo.load(
      parseUuidV7(taskId),
      this.tx,
    );
    if (loaded) {
      this.tasks.set(loaded.id, loaded);
    }
    return loaded;
  }

  private async loadVisitTask(taskId: UuidV7): Promise<TaskEntity> {
    const cached = this.visitTaskEntities.get(taskId);
    if (cached) {
      return cached;
    }
    const loaded = await this.deps.taskRepo.load(taskId, this.tx);
    if (!loaded) {
      throw new InvariantViolationError(
        `Task ${taskId} of run ${this.run.id} is missing`,
        "PIPELINE_RUN_TASK_MISSING",
      );
    }
    this.visitTaskEntities.set(loaded.id, loaded);
    return loaded;
  }

  /**
   * The visit's Task, created by its first run: the step's instructions, the
   * run's input, and the node's `retry`/`maxTurns`. A new Task first arrives
   * at its step's concurrency group: with no place but room to wait it is
   * created `waiting_for_concurrency_slot`; a full group creates nothing and
   * returns null, recording the drop for `advancePipelineRun` to report.
   */
  private async taskForVisit(
    queued: QueuedTask,
    previousRun: TaskRunEntity | null,
  ): Promise<TaskEntity | null> {
    const visit = this.visits.get(queued.visitId);
    if (visit?.nodeKind !== "step") {
      throw new InvariantViolationError(
        `decide queued a run on visit ${queued.visitId}, which isn't a step visit of run ${this.run.id}`,
        "PIPELINE_RUN_VISIT_MISSING",
      );
    }
    if (visit.taskId) {
      return await this.loadVisitTask(visit.taskId);
    }
    const stepDefinition = await this.stepDefinitionFor(queued.stepKey);
    const arrival = await this.deps.taskGroup.arrive(
      {
        projectId: this.run.projectId,
        workItemId: this.run.workItemId,
        stepKey: stepDefinition.key,
        concurrency: stepDefinition.concurrency,
      },
      this.tx,
    );
    if (arrival.decision === "drop") {
      const error = new ConcurrencyGroupFullError(
        stepDefinition.key,
        arrival.heldBy,
      );
      this.droppedVisits.push({
        visitId: visit.id,
        error: {
          name: ENGINE_ERRORS.concurrencyGroupFull,
          message: error.message,
          cause: { heldBy: [...arrival.heldBy] },
        },
      });
      return null;
    }
    const instructions =
      buildTaskInstructionsFromStepDefinition(stepDefinition);
    const node = this.version.definitionJson.nodes[visit.nodeId];
    const task = await this.deps.taskRepo.create(
      TaskEntity.create({
        id: parseUuidV7(queued.taskId),
        projectId: this.run.projectId,
        workItemId: this.run.workItemId,
        stepDefinitionId: stepDefinition.id,
        ...instructions,
        inputJson: queued.input,
        retryJson: node?.kind === "step" ? (node.retry ?? null) : null,
        grants: stepDefinition.grants,
        maxTurns:
          node?.kind === "step" ? (node.maxTurns ?? DEFAULT_MAX_TURNS) : null,
        heartbeatSeconds: queued.heartbeatSeconds,
        executionTimeoutSeconds: queued.executionTimeoutSeconds,
        status:
          arrival.decision === "wait"
            ? "waiting_for_concurrency_slot"
            : "queued",
        startedByUserId: this.run.triggeredByUserId,
        startedByAutomationId: this.run.startedByAutomationId,
        previousTaskId:
          previousRun?.kind === instructions.kind ? previousRun.taskId : null,
        createdAt: this.now,
      }),
      this.tx,
    );
    this.visitTaskEntities.set(task.id, task);
    await this.deps.pipelineRunRepo.setVisitTask(visit.id, task.id, this.tx);
    this.visits.set(visit.id, visit.withTaskId(task.id));
    return task;
  }

  private async queueTask(queued: QueuedTask): Promise<void> {
    const previousTask = queued.previousTaskId
      ? await this.loadTask(queued.previousTaskId)
      : null;
    const visitTask = await this.taskForVisit(queued, previousTask);
    if (!visitTask) {
      return;
    }
    if (visitTask.status !== "waiting_for_concurrency_slot") {
      const task = await this.deps.taskRunRepo.create(
        visitTask.newRun({
          id: parseUuidV7(queued.id),
          number: queued.attemptNumber,
          reason: queued.reason,
          status: "queued",
          baseBranch: queued.baseBranch,
          now: this.now,
        }),
        this.tx,
      );
      this.deps.workNotifier.enqueued(task.projectId);
      this.tasks.set(task.id, task);
      this.queuedTaskIds.push(task.id);
      const { after } = await syncTaskWithRun(task, this.deps, this.tx);
      this.visitTaskEntities.set(after.id, after);
    }

    if (queued.message !== null) {
      const author = this.visits.get(queued.visitId)?.createdByUserId;
      if (!author) {
        throw new InvariantViolationError(
          "A step message needs the user who sent it",
          "PIPELINE_RUN_MESSAGE_AUTHOR_MISSING",
        );
      }
      this.messages.push(
        await this.deps.taskMessageRepo.create(
          TaskMessageEntity.create({
            taskId: visitTask.id,
            authorUserId: author,
            body: queued.message,
            quoteText: this.options.messageQuoteText ?? null,
            createdAt: this.now,
          }),
          this.tx,
        ),
      );
    }
  }

  private async cancelTask(taskId: string): Promise<void> {
    const task = await this.loadTask(taskId);
    if (!task || task.hasOutcome()) {
      return;
    }
    const cancelled = await this.deps.taskRunRepo.save(
      task.withStatus("cancelled", this.now, {
        completedAt: this.now,
        clearClaim: true,
      }),
      this.tx,
    );
    this.tasks.set(cancelled.id, cancelled);
    await onRunEnded(
      cancelled,
      {
        ...this.deps,
        taskOutcomePort: noopTaskOutcomePort,
        endedTaskSessions: this.endedSessionObjectKeys,
      },
      this.tx,
    );
  }
}

/** Everything `decide` reads about `run`, and the rows it came from. */
export const loadRunState = async (
  run: PipelineRunEntity,
  deps: Pick<
    AdvancePipelineRunDeps,
    "pipelineRunRepo" | "workItemRepo" | "nodeVisitQuestionRepo" | "taskRunRepo"
  >,
  tx: DbExecutor,
): Promise<{
  state: RunState;
  history: PipelineRunHistory;
  tasks: Map<string, TaskRunEntity>;
  workItem: WorkItemEntity | null;
}> => {
  const [history, workItem, questions] = await Promise.all([
    deps.pipelineRunRepo.loadHistory(run.id, tx),
    deps.workItemRepo.load(parseWorkItemId(run.workItemId), tx),
    deps.nodeVisitQuestionRepo.loadByRunId(run.id, tx),
  ]);
  const taskEntities = await deps.taskRunRepo.loadManyByIds(
    history.visitTasks.map((link) => parseUuidV7(link.taskId)),
    tx,
  );
  const tasks = new Map<string, TaskRunEntity>(
    taskEntities.map((task) => [task.id, task]),
  );
  return {
    history,
    tasks,
    workItem,
    state: {
      run: run.toRunInfo(),
      visits: history.visits.map((visit) => visit.toEngineVisit()),
      laneGroups: history.laneGroups,
      lanes: history.lanes,
      visitTasks: history.visitTasks,
      tasks: taskEntities.map(toTaskInfo),
      questions,
      workItem: {
        title: workItem?.title ?? "",
        description: workItem?.description ?? null,
        fields: workItem?.fields ?? {},
      },
    },
  };
};

/**
 * Every change to a run goes through here. In one transaction it locks the
 * run row (`SELECT … FOR UPDATE`), loads the whole run, asks the pure
 * `decide` what to do about `event`, and writes the commands it returns in
 * order. Report `completion` once the outermost transaction commits.
 */
export const advancePipelineRun = async (
  pipelineRunId: UuidV7,
  event: EngineEvent,
  deps: AdvancePipelineRunDeps,
  dbExecutor?: DbExecutor,
  options: AdvanceOptions = {},
): Promise<Result<AdvanceOutcome, AdvanceError>> => {
  const db = dbExecutor ?? getDb();
  return await db.transaction(async (tx) => {
    const before = await deps.pipelineRunRepo.lock(pipelineRunId, tx);
    if (!before) {
      return Result.err(
        new ResourceNotFoundError("Pipeline run", pipelineRunId),
      );
    }
    const version = await deps.pipelineGraphVersionRepo.load(
      before.pipelineGraphVersionId,
      tx,
    );
    if (!version) {
      return Result.err(
        new ResourceNotFoundError(
          "Pipeline graph version",
          before.pipelineGraphVersionId,
        ),
      );
    }

    const { state, history, tasks, workItem } = await loadRunState(
      before,
      deps,
      tx,
    );
    const now = deps.timeProvider.now();
    let decided;
    try {
      decided = decide(version.definitionJson, state, event, {
        newId: createUuidV7,
        now: now.toISOString(),
      });
    } catch (error) {
      if (error instanceof DecideError) {
        return Result.err(decideErrorToResult(error, event));
      }
      throw error;
    }

    const writer = new CommandWriter(
      before,
      history,
      tasks,
      version,
      workItem,
      now,
      deps,
      tx,
      options,
    );
    for (const command of decided.commands) {
      await writer.apply(command);
    }
    let after =
      writer.run === before
        ? before
        : await deps.pipelineRunRepo.save(writer.run, tx);
    const messages = [...writer.messages];
    const queuedTaskIds = [...writer.queuedTaskIds];
    const endedSessionObjectKeys = new Set(writer.endedSessionObjectKeys);

    for (const dropped of writer.droppedVisits) {
      const outcome = await advancePipelineRun(
        pipelineRunId,
        { type: "task_dropped", ...dropped },
        deps,
        tx,
        options,
      );
      if (!outcome.ok) {
        return outcome;
      }
      after = outcome.value.run;
      messages.push(...outcome.value.messages);
      queuedTaskIds.push(...outcome.value.queuedTaskIds);
      for (const key of outcome.value.endedSessionObjectKeys) {
        endedSessionObjectKeys.add(key);
      }
    }

    return Result.ok({
      run: after,
      completion: detectRunCompletion(before, after),
      ignored: decided.ignored ?? null,
      messages,
      queuedTaskIds,
      endedSessionObjectKeys: [...endedSessionObjectKeys],
    });
  });
};
