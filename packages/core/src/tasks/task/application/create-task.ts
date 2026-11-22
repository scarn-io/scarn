import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import type { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import { taskRunEntityToContract } from "@scarn/core/tasks/task-run/application/task-run-contract-mapper";
import {
  createTaskInputSchema,
  type CreateTaskInput,
  type CreatedTaskContract,
} from "../contracts/task-contracts";
import { Result } from "@scarn/core/lib/result";
import {
  applyEnvironmentSelection,
  type ApplyEnvironmentSelectionDeps,
} from "./apply-environment-selection";
import type { TaskGroup } from "./task-group";
import type { TaskRepo } from "./task-repo";
import { taskEntityToContract } from "./task-contract-mapper";
import {
  promptTaskExecutionConfig,
  promptTaskSpec,
  startTask,
  stepDefinitionTaskSpec as specFromStepDefinition,
  type StandaloneTaskSpec,
} from "./start-task-from-step-definition";

const stepDefinitionTaskSpec = async (
  input: {
    projectId: string;
    stepDefinitionId: string;
    stepDefinitionVersion: number;
  },
  stepDefinitionRepo: StepDefinitionRepo,
  dbExecutor: DbExecutor | undefined,
): Promise<StandaloneTaskSpec> => {
  const stepDefinition = await stepDefinitionRepo.load(
    parseUuidV7(input.stepDefinitionId),
    dbExecutor,
  );
  if (!stepDefinition || stepDefinition.projectId !== input.projectId) {
    throw new ResourceNotFoundError("Step definition", input.stepDefinitionId);
  }
  if (stepDefinition.version !== input.stepDefinitionVersion) {
    throw new CoreValidationError(
      `Step definition ${stepDefinition.id} is version ${String(stepDefinition.version)}, not ${String(input.stepDefinitionVersion)}`,
      "STEP_DEFINITION_VERSION_MISMATCH",
    );
  }
  return specFromStepDefinition(stepDefinition);
};

const loadStepConfig = async (
  spec: StandaloneTaskSpec,
  taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "load">,
  tx: DbExecutor,
): Promise<TaskExecutionConfigEntity | null> => {
  if (spec.taskExecutionConfigId === null) return null;
  const config = await taskExecutionConfigRepo.load(
    spec.taskExecutionConfigId,
    tx,
  );
  if (config === null) {
    throw new InvariantViolationError(
      `Task execution config ${spec.taskExecutionConfigId} not found`,
      "TASK_EXECUTION_CONFIG_NOT_FOUND",
    );
  }
  return config;
};

const findPromptTaskConfig = async (
  config: TaskExecutionConfigEntity,
  taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "findOrCreate">,
  tx: DbExecutor,
): Promise<TaskExecutionConfigEntity | null> =>
  config.isEmpty()
    ? null
    : await taskExecutionConfigRepo.findOrCreate(config, tx);

/**
 * Creates a standalone Task, from a step-definition version or from a
 * prompt, in one transaction (see `startTask`). A prompt Task runs on
 * `promptTaskExecutionConfig` (`readOnly` unless `repoWrite`). `environment` overrides the
 * Task's environment and adds connectors (`applyEnvironmentSelection`). A
 * step whose concurrency group is full creates nothing and throws
 * `ConcurrencyGroupFullError` (409 `Scarn.ConcurrencyGroupFull`, naming the
 * Tasks that hold the group).
 */
export const createTask = async (
  input: CreateTaskInput,
  {
    userAuthz,
    taskRepo,
    taskRunRepo,
    stepDefinitionRepo,
    workItemRepo,
    workItemBlockRepo,
    taskGroup,
    environmentRepo,
    taskExecutionConfigRepo,
    timeProvider,
    workNotifier,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRepo: TaskRepo;
    taskRunRepo: TaskRunRepo;
    stepDefinitionRepo: StepDefinitionRepo;
    workItemRepo: WorkItemRepo;
    workItemBlockRepo: WorkItemBlockRepo;
    taskGroup: Pick<TaskGroup, "arrive">;
    environmentRepo: ApplyEnvironmentSelectionDeps["environmentRepo"];
    taskExecutionConfigRepo: Pick<
      TaskExecutionConfigRepo,
      "load" | "findOrCreate"
    >;
    timeProvider: TimeProvider;
    workNotifier: WorkNotifier;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<CreatedTaskContract> => {
  const parsedInput = createTaskInputSchema.parse(input);
  const projectId = parseUuidV7(parsedInput.projectId);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:write",
  });

  const workItem = await workItemRepo.load(
    parseWorkItemId(parsedInput.workItemId),
    dbExecutor,
  );
  if (!workItem || workItem.projectId !== projectId) {
    throw new ResourceNotFoundError("Work item", parsedInput.workItemId);
  }
  const spec =
    "prompt" in parsedInput
      ? promptTaskSpec(parsedInput.prompt)
      : await stepDefinitionTaskSpec(
          parsedInput,
          stepDefinitionRepo,
          dbExecutor,
        );

  const db = dbExecutor ?? getDb();
  return await db.transaction(async (tx) => {
    const baseConfig =
      "prompt" in parsedInput
        ? await findPromptTaskConfig(
            promptTaskExecutionConfig(projectId, parsedInput.repoWrite),
            taskExecutionConfigRepo,
            tx,
          )
        : await loadStepConfig(spec, taskExecutionConfigRepo, tx);
    const applied = Result.unwrap(
      await applyEnvironmentSelection(
        {
          projectId,
          baseConfig,
          stepKind: spec.kind,
          override:
            parsedInput.environment?.name === undefined
              ? null
              : { name: parsedInput.environment.name },
          extraConnectors: parsedInput.environment?.extraConnectors ?? [],
        },
        { environmentRepo, taskExecutionConfigRepo },
        tx,
      ),
    );
    const started = await startTask(
      {
        ...spec,
        taskExecutionConfigId: applied.taskExecutionConfigId,
        environmentSelection: applied.selection,
      },
      {
        projectId,
        workItemId: parseUuidV7(workItem.id),
        inputJson: parsedInput.inputJson ?? null,
        executionTimeoutSeconds: parsedInput.executionTimeoutSeconds ?? null,
        startedByUserId: userAuthz.actorId,
      },
      {
        taskRepo,
        taskRunRepo,
        workItemBlockRepo,
        taskGroup,
        timeProvider,
        workNotifier,
      },
      tx,
    );
    const { task, run } = Result.unwrap(started);
    return {
      task: taskEntityToContract(task),
      run: run === null ? null : taskRunEntityToContract(run),
    };
  });
};
