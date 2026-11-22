import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import {
  promptTaskSpec,
  startTask,
  type StartTaskDeps,
} from "@scarn/core/tasks/task/application/start-task-from-step-definition";
import {
  createRepoConversationInputSchema,
  type CreateRepoConversationInput,
  type CreatedRepoConversationContract,
} from "../contracts/conversation-contracts";
import { ConversationEntity } from "../domain/conversation-entity";
import { ConversationMessageEntity } from "../domain/conversation-message-entity";
import { REPO_ASK_PROMPT } from "../domain/repo-ask-prompt";
import type { ConversationRepo } from "./conversation-repo";

export type CreateRepoConversationDeps = StartTaskDeps & {
  userAuthz: UserAuthorizationService;
  projectRepo: Pick<ProjectRepo, "load">;
  conversationRepo: Pick<ConversationRepo, "create" | "insertMessage">;
  taskExecutionConfigRepo: Pick<TaskExecutionConfigRepo, "findOrCreate">;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * The chat Task's execution config: git `readOnly` with no credentials, so
 * nothing the agent changes can be pushed.
 */
const repoAskExecutionConfig = (projectId: UuidV7) =>
  TaskExecutionConfigEntity.create({
    projectId,
    content: {
      environment: null,
      git: { mode: "readOnly", gitCredentials: "none" },
      mcp: null,
      healthChecks: null,
    },
  });

/**
 * A person asks about the project's repo: in one transaction, a
 * `reply_pending` Conversation with their question as its first message, and
 * its chat Task (no work item, empty grants, the fixed repo-ask prompt) with
 * a queued `initial` run. The question reaches the agent from the
 * conversation, never from the Task's prompt. Needs `executions:write`. The
 * repo is the project's `gitUrl`, which every project has: a project row
 * without a valid one fails to load (422 `INVALID_PROJECT_GIT_URL`). Wakes
 * workers once the caller's notify scope ends.
 */
export const createRepoConversation = async (
  input: CreateRepoConversationInput,
  deps: CreateRepoConversationDeps,
): Promise<Result<CreatedRepoConversationContract, ResourceNotFoundError>> => {
  const parsed = createRepoConversationInputSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();
  return await db.transaction(async (tx) => {
    await deps.userAuthz.requireProjectPermission({
      projectId: parsed.projectId,
      permission: "executions:write",
      dbExecutor: tx,
    });
    const project = await deps.projectRepo.load(parsed.projectId, tx);
    if (!project) {
      return Result.err(new ResourceNotFoundError("Project", parsed.projectId));
    }
    const now = deps.timeProvider.now();
    const conversation = await deps.conversationRepo.create(
      ConversationEntity.open({ projectId: project.id, now }),
      tx,
    );
    await deps.conversationRepo.insertMessage(
      ConversationMessageEntity.person({
        conversationId: conversation.id,
        authorUserId: deps.userAuthz.actorId,
        body: parsed.body,
        createdAt: now,
      }),
      tx,
    );
    const config = await deps.taskExecutionConfigRepo.findOrCreate(
      repoAskExecutionConfig(project.id),
      tx,
    );
    const { task, run } = Result.unwrap(
      await startTask(
        promptTaskSpec(REPO_ASK_PROMPT, config.id),
        {
          projectId: project.id,
          workItemId: null,
          conversationId: conversation.id,
          inputJson: null,
          executionTimeoutSeconds: null,
          startedByUserId: deps.userAuthz.actorId,
        },
        deps,
        tx,
      ),
    );
    if (run === null) {
      throw new InvariantViolationError(
        `Chat Task ${task.id} started with no run`,
        "TASK_RUN_MISSING",
      );
    }
    return Result.ok({
      conversationId: conversation.id,
      taskId: task.id,
      taskRunId: run.id,
    });
  });
};
