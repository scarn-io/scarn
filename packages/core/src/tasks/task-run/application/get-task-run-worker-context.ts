import {
  type CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { inlineConfigFieldsFromTaskExecutionConfig } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-contract-mapper";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import type { EnvironmentRepo } from "@scarn/core/pipeline-definitions/environment/application/environment-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  getTaskRunInputSchema,
  getTaskRunWorkerContextInputSchema,
  type GetTaskRunInput,
  type GetTaskRunWorkerContextInput,
  type TaskRunWorkerContextContract,
} from "../contracts/task-run-contracts";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import { resolveProjectOwnerUsernames } from "@scarn/core/projects/project/application/resolve-project-owner-usernames";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { buildTurnGuidancePromptLines } from "./task-run-worker-context-turn-guidance";
import { loadRestoreSession } from "./task-run-worker-context-restore";
import {
  buildChatPromptLines,
  buildChatRestoredMessage,
  buildConversationPromptLines,
  buildRestoredSessionMessage,
  loadChatTurn,
  loadConversationContinuation,
  type ConversationContinuation,
} from "./task-run-worker-context-conversation";
import {
  buildChatTurnPreamble,
  buildRepoAskPromptLines,
  type ChatRepoContext,
} from "./task-run-worker-context-repo-ask";
import { assertClaimOwnership } from "./task-run-claim-helpers";
import {
  resolveRunEnvironment,
  runEnvironmentFitsStep,
} from "./task-run-worker-context-environment";
import type { TaskRunHistoryReader } from "./task-run-history-reader";
import type { TaskRunRepo } from "./task-run-repo";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import type { TaskRunStepKeyReader } from "./task-run-step-key-reader";
import { loadTaskFacts } from "./task-run-worker-context-task-facts";
import type { StepDefinitionRepo } from "@scarn/core/pipeline-definitions/step-definition/application/step-definition-repo";
import {
  buildSteeringPromptLines,
  loadStepSteering,
  type StepSteering,
} from "./task-run-worker-context-steering";

const CURRENT_EXECUTION_INFO_RELATIVE_PATH =
  ".scarn/current-execution/execution.json";
const STEP_INSTRUCTIONS_PLACEHOLDER = "__SCARN_STEP_INSTRUCTIONS__";
/** Only for a Task on a work item; a chat (no work item) gets no such line. */
const WORK_ITEM_PROMPT_LINE =
  "Your work item is the one this Task runs on (its work item id is above). Read it live with `scarn-get-work-item` before you change it; leave out `workItemId` to read your own. Changes are recorded as you call the tools and applied when your run ends successfully.";

function buildPromptText(input: {
  prompt: string;
  projectId: string;
  taskRunId: string;
  workItemId: string | null;
  stepKey: string | null;
  inputJson: unknown;
  steering: StepSteering;
  continuation: ConversationContinuation | null;
  chat: ChatRepoContext | null;
  baseWorkBranch: string | null;
  stepBaseBranch: string | null;
  turnsRemaining: number | null;
  isConversationStep: boolean;
}): string {
  if (input.chat && input.continuation) {
    return [
      `You are answering questions in a Scarn repo conversation for project ${input.projectId}.`,
      `Task run id: ${input.taskRunId}`,
      "",
      "Step instructions:",
      input.prompt,
      "",
      ...buildRepoAskPromptLines(input.chat),
      "",
      ...buildChatPromptLines(input.continuation),
      `Current execution metadata file: \`${CURRENT_EXECUTION_INFO_RELATIVE_PATH}\``,
      "It contains the current task run id.",
    ].join("\n");
  }
  return [
    `You are executing a Scarn step for project ${input.projectId}.`,
    `Task run id: ${input.taskRunId}`,
    ...(input.workItemId === null ? [] : [`Work item id: ${input.workItemId}`]),
    ...(input.stepKey ? [`Step key: ${input.stepKey}`] : []),
    "",
    "Step instructions:",
    input.prompt,
    "",
    ...buildSteeringPromptLines({
      steering: input.steering,
      baseWorkBranch: input.baseWorkBranch,
      stepBaseBranch: input.stepBaseBranch,
    }),
    ...buildConversationPromptLines(input.continuation),
    ...(input.workItemId === null ? [] : [WORK_ITEM_PROMPT_LINE]),
    "",
    "Step input JSON:",
    "```json",
    JSON.stringify(input.inputJson ?? null, null, 2),
    "```",
    "",
    `Current execution metadata file: \`${CURRENT_EXECUTION_INFO_RELATIVE_PATH}\``,
    ...(input.isConversationStep
      ? [
          input.workItemId === null
            ? "It contains the current task run id."
            : "It contains the current task run id and work item id.",
        ]
      : [
          "It contains the current task run id, work item id and the findings result schema.",
          "If this step declares artifact fields, submit each file with `scarn-submit-artifact` before submitting findings.",
          "Before ending the task, call the Scarn completion tool `scarn-submit-step-findings`.",
          "Pass only `findingsJson`.",
          "The tool will load the current execution metadata file and validate the findings against the stored schema.",
        ]),
    ...buildTurnGuidancePromptLines({
      turnsRemaining: input.turnsRemaining,
      isConversationStep: input.isConversationStep,
    }),
  ].join("\n");
}

const workerTaskInstructions = (task: TaskRunEntity) => {
  switch (task.kind) {
    case "agent":
      return { prompt: task.prompt, entrypointJson: null, toolCall: null };
    case "code":
      return {
        prompt: null,
        entrypointJson: task.entrypointJson,
        toolCall: null,
      };
    case "mcp_tool":
      return {
        prompt: null,
        entrypointJson: null,
        toolCall: task.toolCallJson,
      };
    default:
      return assertNever(task);
  }
};

export const getTaskRunWorkerContext = async (
  taskIdInput: GetTaskRunInput,
  input: GetTaskRunWorkerContextInput,
  {
    userAuthz,
    projectRepo,
    taskRepo,
    taskRunRepo,
    taskExecutionConfigRepo,
    environmentRepo,
    workItemRepo,
    stepDefinitionRepo,
    taskRunStepKeyReader,
    taskRunHistoryReader,
    timeProvider,
    objectStore,
    conversationRepo,
    usernameReader,
    orgRepo,
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: ProjectRepo;
    taskRepo: Pick<TaskRepo, "load">;
    taskRunRepo: TaskRunRepo;
    taskExecutionConfigRepo: TaskExecutionConfigRepo;
    environmentRepo: Pick<
      EnvironmentRepo,
      "findVersionById" | "findLiveWithLatestVersionByName"
    >;
    workItemRepo: WorkItemRepo;
    stepDefinitionRepo: Pick<StepDefinitionRepo, "load">;
    taskRunStepKeyReader: TaskRunStepKeyReader;
    taskRunHistoryReader: TaskRunHistoryReader;
    timeProvider: TimeProvider;
    objectStore?: ObjectStore | null | undefined;
    conversationRepo: ConversationRepo;
    usernameReader: UsernameReader;
    orgRepo: OrgRepo;
  },
): Promise<
  Result<
    TaskRunWorkerContextContract,
    ResourceNotFoundError | CoreValidationError
  >
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = getTaskRunWorkerContextInputSchema.parse(input);
  const task = await taskRunRepo.load(taskRunId);

  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });
  const now = timeProvider.now();
  assertClaimOwnership(task, parsedInput.claimToken, now);
  const { workItemId } = task;

  const history = await taskRunHistoryReader.loadHistory(task.id, now);

  const [project, pipelineStepKey, taskExecutionConfig, workItem, steering] =
    await Promise.all([
      projectRepo.load(task.projectId),
      taskRunStepKeyReader.loadStepKey(task.id),
      task.taskExecutionConfigId
        ? taskExecutionConfigRepo.load(task.taskExecutionConfigId)
        : Promise.resolve(null),
      task.name || workItemId === null
        ? Promise.resolve(null)
        : workItemRepo.load(parseWorkItemId(workItemId)),
      loadStepSteering({ history, reason: task.reason, taskRunRepo }),
    ]);
  const {
    turnsRemaining,
    grants,
    chatConversationId,
    extraConnectors,
    declaredErrors,
    stepDefinitionKey,
  } = await loadTaskFacts(task, { taskRepo, taskRunRepo, stepDefinitionRepo });
  const stepKey = pipelineStepKey ?? stepDefinitionKey;
  const conversationDeps = { conversationRepo, usernameReader, timeProvider };
  const isChat = chatConversationId !== null;
  const inline = inlineConfigFieldsFromTaskExecutionConfig(taskExecutionConfig);
  const stepBaseBranch = inline.repo.baseBranch;
  const baseWorkBranch = isChat
    ? task.baseBranch
    : (steering.continuedBranch?.workBranch ??
      (stepBaseBranch === null ? task.baseBranch : null));
  const chat: ChatRepoContext | null =
    isChat && project
      ? {
          taskRunId: task.id,
          gitUrl: project.gitUrl,
          baseBranch: task.baseBranch,
          baseCommit: task.baseCommit,
        }
      : null;
  const continuation = isChat
    ? await loadChatTurn(
        { task, conversationId: chatConversationId },
        conversationDeps,
      )
    : await loadConversationContinuation({ task, steering }, conversationDeps);
  const restoreMessage = continuation
    ? chat
      ? buildChatTurnPreamble(chat) + buildChatRestoredMessage(continuation)
      : buildRestoredSessionMessage(continuation.delivered)
    : null;
  const restoreSession =
    task.kind === "agent"
      ? await loadRestoreSession({
          task,
          message: restoreMessage,
          taskRunRepo,
          objectStore,
        })
      : null;

  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", task.projectId));
  }

  if (task.taskExecutionConfigId && !taskExecutionConfig) {
    return Result.err(
      new ResourceNotFoundError(
        "Task execution config",
        task.taskExecutionConfigId,
      ),
    );
  }

  const ownerUsername = (
    await resolveProjectOwnerUsernames([project], { orgRepo, usernameReader })
  ).get(project.id);
  const title = task.name ?? workItem?.title ?? null;
  const displayName = title ?? task.id;
  const environment = await resolveRunEnvironment(task, inline.environment, {
    environmentRepo,
    taskRunRepo,
  });
  const misfit = runEnvironmentFitsStep({
    environment,
    stepKind: task.kind,
    stepConfig: taskExecutionConfig,
    extraConnectors,
  });
  if (misfit !== null) return Result.err(misfit);

  const runtimeConfigContract = {
    relativePath: ".scarn/scarn.jsonc",
    present: false,
    commands: [],
    services: [],
  };

  return Result.ok({
    projectId: task.projectId,
    projectPath: ownerUsername ? `${ownerUsername}/${project.slug}` : null,
    gitUrl: project.gitUrl,
    baseWorkBranch,
    projectOpencodeConfig: runtimeConfigContract,
    task: {
      id: task.id,
      status: task.status,
      kind: task.kind,
      key: stepKey ?? task.id,
      name: displayName,
      inputJson: task.inputJson,
      executionTimeoutSeconds: task.executionTimeoutSeconds,
      ...workerTaskInstructions(task),
      resultSchemaJson: task.resultSchemaJson,
      declaredErrors,
      turnsRemaining,
      workItemId,
      conversationId: chatConversationId,
      grants,
    },
    runtime: {
      environment,
      repo: inline.repo,
      healthChecksJson: inline.healthChecksJson,
      opencodeMcpJson: inline.opencodeMcpJson,
      extraConnectors,
    },
    agentPrompt: {
      sessionTitle: title ? `${title} (${task.id})` : task.id,
      promptText: buildPromptText({
        prompt: STEP_INSTRUCTIONS_PLACEHOLDER,
        projectId: task.projectId,
        taskRunId: task.id,
        workItemId,
        stepKey,
        inputJson: task.inputJson,
        steering,
        continuation,
        chat,
        baseWorkBranch,
        stepBaseBranch,
        turnsRemaining,
        isConversationStep: task.resultSchemaJson === null,
      }),
      instructionsPlaceholder: STEP_INSTRUCTIONS_PLACEHOLDER,
    },
    previousRun: isChat ? null : steering.previousRun,
    baseCommit: task.baseCommit,
    restoreSession,
  });
};
