/**
 * What happens when a Task ends (succeeded, failed after its retries, or
 * cancelled), in or out of a pipeline: its conversation closes and its runs'
 * saved sessions are released (columns cleared, bytes taken off the meter)
 * and collected for deletion once the transaction commits.
 * A Task with no result schema whose run succeeded ends its conversation
 * with the run's `{ conversationId, summary }` first. A Task with no result
 * schema that succeeded after talking to a person also posts its summary on
 * the work item, as an agent comment authored by the Task's name. A chat
 * (a Task with no work item) posts no summary comment, and a failed one keeps
 * its conversation open.
 */
import { z } from "zod";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { ConversationEntity } from "@scarn/core/conversations/conversation/domain/conversation-entity";
import { ConversationMessageEntity } from "@scarn/core/conversations/conversation/domain/conversation-message-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import { WorkItemCommentEntity } from "@scarn/core/work-items/work-item-comment/domain/work-item-comment-entity";
import type { EndedTaskSessions } from "@scarn/core/tasks/task-run/application/delete-task-sessions";
import {
  releaseTaskRunSessions,
  type TaskRunSessionsDeps,
} from "@scarn/core/tasks/task-run/application/task-run-sessions";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { GrantRequestRepo } from "@scarn/core/tasks/grant-request/application/grant-request-repo";
import { withdrawGrantRequest } from "@scarn/core/tasks/grant-request/domain/grant-request";
import type { TaskEntity, TaskStatus } from "../domain/task-entity";
import type { TaskGroup } from "./task-group";
import type { TaskRepo } from "./task-repo";

export type OnTaskEndedDeps = Omit<TaskRunSessionsDeps, "taskRunRepo"> & {
  taskRepo: TaskRepo;
  grantRequestRepo: Pick<GrantRequestRepo, "findPendingByTaskId" | "save">;
  taskRunRepo: Pick<TaskRunRepo, "listByTaskId" | "clearSessions">;
  conversationRepo: ConversationRepo;
  workItemCommentRepo: Pick<WorkItemCommentRepo, "create">;
  timeProvider: TimeProvider;
  /** Lets the next waiting Task of the ended Task's concurrency group in. */
  taskGroup: Pick<TaskGroup, "ended">;
  /** Collects the ended Tasks' sessions; the transaction's owner deletes them after commit. */
  endedTaskSessions?: EndedTaskSessions | undefined;
};

const ENDED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export const isTaskEnded = (task: TaskEntity): boolean =>
  ENDED_TASK_STATUSES.has(task.status);

const summaryResultSchema = z.object({ summary: z.string() });
const conversationResultSchema = z.object({
  conversationId: z.string(),
  summary: z.string(),
});

/** Whether `run` belongs to a Task that ends as a conversation: an agent Task with no result schema. */
export const endsAsConversation = (run: TaskRunEntity): boolean =>
  run.kind === "agent" && run.resultSchemaJson === null;

/**
 * The result a succeeded run of a Task with no result schema stores:
 * `{ conversationId, summary }`, the Task's conversation (a new id when it
 * has none yet) and the trimmed summary the agent reported.
 */
export const conversationResult = (
  task: TaskEntity,
  reported: AnyJsonValue,
): { conversationId: UuidV7; summary: string } => {
  const parsed = summaryResultSchema.safeParse(reported);
  return {
    conversationId: task.conversationId ?? createUuidV7(),
    summary: parsed.success ? parsed.data.summary.trim() : "",
  };
};

/**
 * Posts the summary of a Task with no result schema whose `run` succeeded as
 * the agent's closing message (when it isn't empty), creating the
 * conversation the run's result names when the agent never handed over.
 */
const writeClosingMessage = async (
  task: TaskEntity,
  run: TaskRunEntity,
  deps: OnTaskEndedDeps,
  tx: DbExecutor,
): Promise<TaskEntity> => {
  const parsed = conversationResultSchema.safeParse(run.resultJson);
  if (!parsed.success) {
    return task;
  }
  const now = deps.timeProvider.now();
  const conversationId = parseUuidV7(parsed.data.conversationId);
  let ended = task;
  if (task.conversationId === null) {
    await deps.conversationRepo.create(
      ConversationEntity.start({
        id: conversationId,
        projectId: task.projectId,
        workItemId: task.workItemId,
        now,
      }),
      tx,
    );
    ended = await deps.taskRepo.save(
      task.withConversation(conversationId, now),
      tx,
    );
  }
  if (parsed.data.summary) {
    await deps.conversationRepo.insertMessage(
      ConversationMessageEntity.agent({
        conversationId,
        taskRunId: run.id,
        body: parsed.data.summary,
        createdAt: now,
      }),
      tx,
    );
  }
  return ended;
};

/** The summary comment's body: the agent's last message, then the branch it worked on. */
const summaryCommentBody = (summary: string, runs: TaskRunEntity[]): string => {
  const branch = runs
    .filter((each) => each.workBranch)
    .sort((left, right) => right.number - left.number)[0]?.workBranch;
  return branch ? `${summary}\n\nBranch: \`${branch}\`` : summary;
};

/**
 * Posts the summary of a succeeded Task with no result schema whose
 * conversation had a person in it on the work item: its last agent message
 * (the summary it closed with, or the one a person ended on with Done) and
 * the branch it worked on. Posted directly, not as a draft. A Task that never
 * talked to a person posts nothing.
 */
const postSummaryComment = async (
  task: TaskEntity,
  messages: ConversationMessageEntity[],
  deps: OnTaskEndedDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (
    task.workItemId === null ||
    task.status !== "succeeded" ||
    task.kind !== "agent" ||
    task.resultSchemaJson !== null ||
    !messages.some((message) => message.authorKind === "person")
  ) {
    return;
  }
  const summary = messages
    .filter((message) => message.authorKind === "agent")
    .at(-1)?.body;
  if (!summary) {
    return;
  }
  await deps.workItemCommentRepo.create(
    WorkItemCommentEntity.createAgentComment({
      projectId: task.projectId,
      workItemId: task.workItemId,
      authoredByTaskId: task.id,
      body: summaryCommentBody(
        summary,
        await deps.taskRunRepo.listByTaskId(task.id, tx),
      ),
      createdAt: deps.timeProvider.now(),
    }),
    tx,
  );
};

/** `task` holding no work item changes, saved, when it failed or was cancelled. */
const dropHeldWorkItemChanges = async (
  task: TaskEntity,
  deps: OnTaskEndedDeps,
  tx: DbExecutor,
): Promise<TaskEntity> =>
  task.status === "succeeded" || task.heldWorkItemChanges.length === 0
    ? task
    : await deps.taskRepo.save(
        task.clearHeldWorkItemChanges(deps.timeProvider.now()),
        tx,
      );

/** Closes the ended Task's `pending` grant request, if any, as `withdrawn`. */
const withdrawPendingRequest = async (
  task: TaskEntity,
  deps: OnTaskEndedDeps,
  tx: DbExecutor,
): Promise<void> => {
  const pending = await deps.grantRequestRepo.findPendingByTaskId(task.id, tx);
  if (pending) {
    await deps.grantRequestRepo.save(withdrawGrantRequest(pending), tx);
  }
};

/** A failed chat (no work item or schedule) keeps its conversation open so it can be retried. */
const staysOpen = (task: TaskEntity): boolean =>
  task.workItemId === null &&
  task.startedByScheduleId === null &&
  task.status === "failed";

/**
 * `task` just ended because `run` ended (or a person ended it, or it was
 * cancelled): closes its conversation (posting its summary comment, see
 * `postSummaryComment`), releases its runs' sessions and frees its place in
 * its concurrency group (`TaskGroup.ended`). A Task that failed or was
 * cancelled drops the work item changes it held from hand-overs, and a
 * grant request still pending is withdrawn. Returns the Task as saved.
 */
export const onTaskEnded = async (
  endedTask: TaskEntity,
  run: TaskRunEntity | null,
  deps: OnTaskEndedDeps,
  tx: DbExecutor,
): Promise<TaskEntity> => {
  const task = await dropHeldWorkItemChanges(endedTask, deps, tx);
  await withdrawPendingRequest(task, deps, tx);
  const ended =
    run &&
    task.status === "succeeded" &&
    run.status === "succeeded" &&
    endsAsConversation(run)
      ? await writeClosingMessage(task, run, deps, tx)
      : task;
  if (ended.conversationId !== null && !staysOpen(ended)) {
    const conversation = await deps.conversationRepo.lock(
      ended.conversationId,
      tx,
    );
    if (conversation && !conversation.isClosed) {
      await deps.conversationRepo.save(
        conversation.close(deps.timeProvider.now()),
        tx,
      );
      await postSummaryComment(
        ended,
        await deps.conversationRepo.listMessages(conversation.id, tx),
        deps,
        tx,
      );
    }
  }
  await releaseTaskRunSessions(
    await deps.taskRunRepo.listByTaskId(ended.id, tx),
    deps,
    tx,
  );
  await deps.taskGroup.ended(ended, tx);
  return ended;
};
