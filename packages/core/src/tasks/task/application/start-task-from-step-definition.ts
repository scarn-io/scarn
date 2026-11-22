import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  buildTaskInstructionsFromStepDefinition,
  type TaskInstructions,
} from "@scarn/core/pipeline-definitions/step-definition/domain/build-task-instructions-from-step-definition";
import type {
  StepConcurrency,
  StepDefinitionEntity,
} from "@scarn/core/pipeline-definitions/step-definition/domain/step-definition-entity";
import { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { TaskEntity, type TaskStatus } from "../domain/task-entity";
import { DEFAULT_STANDALONE_MAX_TURNS } from "../domain/task-turns";
import type { Grant } from "../domain/grants";
import type { TaskEnvironmentSelection } from "../domain/task-environment-selection";
import { ConcurrencyGroupFullError, type TaskGroup } from "./task-group";
import type { TaskRepo } from "./task-repo";

export type StartTaskDeps = {
  taskRepo: TaskRepo;
  taskRunRepo: TaskRunRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  taskGroup: Pick<TaskGroup, "arrive">;
  timeProvider: TimeProvider;
  workNotifier: WorkNotifier;
};

export type StartTaskFromStepDefinitionDeps = StartTaskDeps;

/** The step key and limit of a step-definition Task's concurrency group. */
export type TaskConcurrencyGroup = {
  stepKey: string;
  concurrency: StepConcurrency | null;
};

export type StandaloneTaskSpec = TaskInstructions & {
  stepDefinitionId: UuidV7 | null;
  retryJson: AnyJsonValue | null;
  grants: readonly Grant[];
  maxTurns: number;
  /** null for a prompt Task, which skips concurrency groups. */
  concurrencyGroup: TaskConcurrencyGroup | null;
  /** The extra connectors a person added (`applyEnvironmentSelection`). */
  environmentSelection?: TaskEnvironmentSelection | null | undefined;
};

/** What a standalone Task runs on: a work item, or a chat's conversation. */
export type StandaloneTaskSubject =
  { workItemId: UuidV7 } | { workItemId: null; conversationId: UuidV7 };

export type StandaloneTaskStart = StandaloneTaskSubject & {
  projectId: UuidV7;
  inputJson: AnyJsonValue | null;
  executionTimeoutSeconds: number | null;
  startedByUserId: UuidV7 | null;
  /** The automation starting the Task; omitted for a person's start. */
  startedByAutomationId?: UuidV7 | null | undefined;
};

export type StartedTask = { task: TaskEntity; run: TaskRunEntity | null };

/**
 * Creates a standalone Task on `workItemId`, or a chat's Task on its
 * conversation (no blockers or concurrency group), in `tx`. Its input is the
 * caller's input as given; the agent reads the work item live. A step-definition Task
 * first arrives at its concurrency group (`TaskGroup.arrive`): a full group
 * creates nothing and returns `ConcurrencyGroupFullError`, and one with no
 * place but room to wait creates the Task `waiting_for_concurrency_slot`,
 * with no run. Otherwise, on a ready item it gets its first run (`initial`);
 * on a blocked one it is `waiting_for_work` with no run, and
 * `startReadyWork` queues the run once the item's blockers close.
 */
export const startTask = async (
  spec: StandaloneTaskSpec,
  start: StandaloneTaskStart,
  deps: StartTaskDeps,
  tx: DbExecutor,
): Promise<Result<StartedTask, ConcurrencyGroupFullError>> => {
  const { concurrencyGroup, ...instructions } = spec;
  const { workItemId } = start;
  const arrival =
    concurrencyGroup && workItemId !== null
      ? await deps.taskGroup.arrive(
          { projectId: start.projectId, workItemId, ...concurrencyGroup },
          tx,
        )
      : ({ decision: "admit" } as const);
  if (arrival.decision === "drop") {
    return Result.err(
      new ConcurrencyGroupFullError(
        concurrencyGroup?.stepKey ?? "",
        arrival.heldBy,
      ),
    );
  }
  const blocked =
    workItemId !== null &&
    (await deps.workItemBlockRepo.listIdsWithOpenBlockers([workItemId], tx))
      .length > 0;
  const status: TaskStatus =
    arrival.decision === "wait"
      ? "waiting_for_concurrency_slot"
      : blocked
        ? "waiting_for_work"
        : "queued";
  const now = deps.timeProvider.now();
  const task = await deps.taskRepo.create(
    TaskEntity.create({
      projectId: start.projectId,
      workItemId,
      conversationId: "conversationId" in start ? start.conversationId : null,
      ...instructions,
      inputJson: start.inputJson,
      executionTimeoutSeconds: start.executionTimeoutSeconds,
      status,
      startedByUserId: start.startedByUserId,
      startedByAutomationId: start.startedByAutomationId ?? null,
      createdAt: now,
    }),
    tx,
  );
  if (status !== "queued") return Result.ok({ task, run: null });
  const run = await deps.taskRunRepo.create(
    task.newRun({ number: 1, reason: "initial", status: "queued", now }),
    tx,
  );
  deps.workNotifier.enqueued(run.projectId);
  return Result.ok({ task, run });
};

/**
 * A prompt Task's execution config (decision 8): the repo default with git
 * `readOnly`, or with `repoWrite` the default `readWrite` with
 * `WorkBranch.create()`. That default is the empty config, which is never
 * stored (`isEmpty`), so such a Task keeps a `null` config.
 */
export const promptTaskExecutionConfig = (
  projectId: UuidV7,
  repoWrite: boolean,
): TaskExecutionConfigEntity =>
  TaskExecutionConfigEntity.create({
    projectId,
    content: {
      environment: null,
      git: repoWrite
        ? { mode: "readWrite", workBranch: { kind: "create" } }
        : { mode: "readOnly" },
      mcp: null,
      healthChecks: null,
    },
  });

/**
 * A prompt Task's spec: an agent with no step definition, result schema,
 * retry policy, grants or concurrency group, and `DEFAULT_STANDALONE_MAX_TURNS`.
 */
export const promptTaskSpec = (
  prompt: string,
  taskExecutionConfigId: UuidV7 | null = null,
): StandaloneTaskSpec => ({
  kind: "agent",
  prompt,
  name: null,
  resultSchemaJson: null,
  taskExecutionConfigId,
  stepDefinitionId: null,
  retryJson: null,
  grants: [],
  maxTurns: DEFAULT_STANDALONE_MAX_TURNS,
  concurrencyGroup: null,
});

/**
 * A step-definition version's instructions, name, execution config, `retry`
 * policy, grants, `maxTurns` (else
 * `DEFAULT_STANDALONE_MAX_TURNS`) and concurrency group, as a standalone
 * Task copies them.
 */
export const stepDefinitionTaskSpec = (
  stepDefinition: StepDefinitionEntity,
): StandaloneTaskSpec => ({
  stepDefinitionId: stepDefinition.id,
  ...buildTaskInstructionsFromStepDefinition(stepDefinition),
  retryJson:
    stepDefinition.retry.length === 0
      ? null
      : stepDefinition.retry.map((entry) => ({
          on: [...entry.on],
          maxAttempts: entry.maxAttempts,
        })),
  grants: stepDefinition.grants,
  maxTurns: stepDefinition.maxTurns ?? DEFAULT_STANDALONE_MAX_TURNS,
  concurrencyGroup: {
    stepKey: stepDefinition.key,
    concurrency: stepDefinition.concurrency,
  },
});

/** Creates a standalone Task from a step-definition version (see `startTask`). */
export const startTaskFromStepDefinition = async (
  stepDefinition: StepDefinitionEntity,
  start: StandaloneTaskStart,
  deps: StartTaskFromStepDefinitionDeps,
  tx: DbExecutor,
): Promise<Result<StartedTask, ConcurrencyGroupFullError>> =>
  await startTask(stepDefinitionTaskSpec(stepDefinition), start, deps, tx);
