import { describe, expect, test, vi } from "bun:test";
import { fixedTimeProvider } from "tests/utils";
import type { DbExecutor } from "@/lib/db/db-executor";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ConversationEntity } from "@/conversations/conversation/domain/conversation-entity";
import {
  retryTask,
  type RetryTaskDeps,
} from "@/tasks/task/application/retry-task";
import { ConcurrencyGroupFullError } from "@/tasks/task/application/task-group";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import { buildTask, LATER, NOW, tx } from "./on-run-ended-fixtures";

const setup = (original = buildTask("failed"), noRuns = false) => {
  let task = original;
  const runs: TaskRunEntity[] = noRuns
    ? []
    : [
        task.newRun({
          number: 1,
          reason: "initial",
          status: "failed",
          baseBranch: "main",
          now: NOW,
        }),
      ];
  const latestId = runs.at(-1)?.id ?? null;
  const lock = vi.fn(() => Promise.resolve(task));
  const save = vi.fn((next: TaskEntity) => {
    task = next;
    return Promise.resolve(next);
  });
  const create = vi.fn((run: TaskRunEntity) => {
    runs.push(run);
    return Promise.resolve(run);
  });
  const requireProjectPermission = vi.fn<
    RetryTaskDeps["userAuthz"]["requireProjectPermission"]
  >(() => Promise.resolve({ membership: null, isPublicNonMemberGrant: false }));
  const findForTask = vi.fn<RetryTaskDeps["taskPipelineRun"]["findForTask"]>(
    () => Promise.resolve(null),
  );
  const reacquire = vi.fn<RetryTaskDeps["taskGroup"]["reacquire"]>(() =>
    Promise.resolve(),
  );
  const closed = ConversationEntity.start({
    id: original.conversationId ?? createUuidV7(),
    projectId: task.projectId,
    workItemId: task.workItemId,
    now: NOW,
  }).close(NOW);
  const conversationLock = vi.fn<RetryTaskDeps["conversationRepo"]["lock"]>(
    () => Promise.resolve(closed),
  );
  const conversationSave = vi.fn((conversation: ConversationEntity) =>
    Promise.resolve(conversation),
  );
  const listIdsWithOpenBlockers = vi.fn(() =>
    Promise.resolve<ReturnType<typeof createUuidV7>[]>([]),
  );
  const deps: RetryTaskDeps = {
    taskRepo: { lock, save } as unknown as TaskRepo,
    taskRunRepo: { listByTaskId: () => Promise.resolve([...runs]), create },
    userAuthz: {
      actorId: createUuidV7(),
      requireProjectPermission,
      requireProjectMember: () =>
        Promise.reject(new Error("requireProjectMember is not used here")),
    },
    conversationRepo: {
      lock: conversationLock,
      save: conversationSave,
    },
    taskPipelineRun: { findForTask },
    taskGroup: { reacquire },
    workItemBlockRepo: { listIdsWithOpenBlockers },
    timeProvider: fixedTimeProvider(LATER),
    dbExecutor: {
      transaction: (work: (executor: DbExecutor) => Promise<unknown>) =>
        work(tx),
    } as DbExecutor,
  };
  return {
    deps,
    input: { taskId: original.id, expectedLatestRunId: latestId },
    lock,
    save,
    create,
    requireProjectPermission,
    findForTask,
    reacquire,
    conversationLock,
    conversationSave,
    listIdsWithOpenBlockers,
  };
};

const buildChat = () =>
  TaskEntity.create({
    projectId: createUuidV7(),
    workItemId: null,
    conversationId: createUuidV7(),
    kind: "agent",
    prompt: "Explain the checkout flow.",
    status: "cancelled",
    createdAt: NOW,
  });

const rejection = async <T>(work: Promise<T>): Promise<Error> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected rejection");
};

describe("retryTask", () => {
  test.concurrent(
    "requires executions:write and creates one retry in the transaction",
    async () => {
      const fixture = setup();
      const result = await retryTask(fixture.input, fixture.deps);
      expect(result.ok).toBe(true);
      expect(fixture.requireProjectPermission).toHaveBeenCalledWith({
        projectId: fixture.create.mock.calls[0]?.[0].projectId,
        permission: "executions:write",
        dbExecutor: tx,
      });
      expect(fixture.lock).toHaveBeenCalledWith(fixture.input.taskId, tx);
      expect(fixture.reacquire).toHaveBeenCalledTimes(1);
      expect(fixture.create.mock.calls[0]?.[0]).toMatchObject({
        taskId: fixture.input.taskId,
        reason: "retry",
        number: 2,
        baseBranch: "main",
      });
      expect(fixture.listIdsWithOpenBlockers).not.toHaveBeenCalled();
      expect(fixture.save.mock.calls[0]?.[0].status).toBe("queued");
    },
  );

  test.concurrent(
    "rejects pipeline ownership with a stable rerun-directed error",
    async () => {
      const fixture = setup();
      fixture.findForTask.mockResolvedValue({
        pipelineRunId: createUuidV7(),
        startedByUserId: null,
      });
      const error = await rejection(retryTask(fixture.input, fixture.deps));
      expect(error).toMatchObject({ code: "TASK_RETRY_PIPELINE_OWNED" });
      expect(error.message).toContain("rerun");
      expect(fixture.reacquire).not.toHaveBeenCalled();
      expect(fixture.save).not.toHaveBeenCalled();
      expect(fixture.create).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "a full group returns the existing error without creating or deferring a run",
    async () => {
      const fixture = setup();
      const full = new ConcurrencyGroupFullError({ stepKey: "fix" }, [
        createUuidV7(),
      ]);
      fixture.reacquire.mockRejectedValue(full);
      expect(await rejection(retryTask(fixture.input, fixture.deps))).toBe(
        full,
      );
      expect(fixture.save).not.toHaveBeenCalled();
      expect(fixture.create).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "a repeated request is stale and cannot create another run",
    async () => {
      const fixture = setup();
      await retryTask(fixture.input, fixture.deps);
      expect(
        await rejection(retryTask(fixture.input, fixture.deps)),
      ).toMatchObject({ code: "TASK_RETRY_STALE_RUN" });
      expect(fixture.create).toHaveBeenCalledTimes(1);
    },
  );

  test.concurrent("denied permission cannot change the Task", async () => {
    const fixture = setup();
    fixture.requireProjectPermission.mockRejectedValue(new Error("forbidden"));
    expect(
      (await rejection(retryTask(fixture.input, fixture.deps))).message,
    ).toBe("forbidden");
    expect(fixture.findForTask).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });

  test.concurrent("reopens the old conversation in agent_turn", async () => {
    const task = buildTask("failed").withConversation(createUuidV7(), NOW);
    const fixture = setup(task);
    await retryTask(fixture.input, fixture.deps);
    expect(fixture.conversationSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.conversationId,
        status: "agent_turn",
        closedAt: null,
      }),
      tx,
    );
  });

  test.concurrent(
    "cancelled without runs stays blocked, returning a null run ID",
    async () => {
      const fixture = setup(buildTask("cancelled"), true);
      fixture.listIdsWithOpenBlockers.mockResolvedValue([createUuidV7()]);
      const result = await retryTask(fixture.input, fixture.deps);
      expect(result).toMatchObject({
        ok: true,
        value: { taskId: fixture.input.taskId, taskRunId: null },
      });
      expect(fixture.save.mock.calls[0]?.[0].status).toBe("waiting_for_work");
      expect(fixture.reacquire).toHaveBeenCalledTimes(1);
      expect(fixture.create).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "a chat (no work item) without runs skips blockers and queues a run",
    async () => {
      const chat = buildChat();
      const fixture = setup(chat, true);
      fixture.conversationLock.mockResolvedValue(
        ConversationEntity.open({
          id: chat.conversationId ?? undefined,
          projectId: chat.projectId,
          now: NOW,
        }),
      );
      fixture.listIdsWithOpenBlockers.mockResolvedValue([createUuidV7()]);
      const result = await retryTask(fixture.input, fixture.deps);
      expect(result.ok).toBe(true);
      expect(fixture.listIdsWithOpenBlockers).not.toHaveBeenCalled();
      expect(fixture.save.mock.calls[0]?.[0].status).toBe("queued");
      expect(fixture.create).toHaveBeenCalledTimes(1);
    },
  );

  test.concurrent(
    "an ended chat (closed conversation) is refused without changes",
    async () => {
      const fixture = setup(buildChat(), true);
      expect(
        await rejection(retryTask(fixture.input, fixture.deps)),
      ).toMatchObject({ code: "CONVERSATION_ENDED" });
      expect(fixture.conversationSave).not.toHaveBeenCalled();
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.save).not.toHaveBeenCalled();
    },
  );
});
