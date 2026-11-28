import { vi } from "bun:test";
import { fixedTimeProvider } from "tests/utils";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import type { DbExecutor } from "@/lib/db/db-executor";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { ConversationRepo } from "@/conversations/conversation/application/conversation-repo";
import type { ConversationEntity } from "@/conversations/conversation/domain/conversation-entity";
import type { UserNotificationEntity } from "@/notifications/user-notification/domain/user-notification-entity";
import type { HandOverDeps } from "@/tasks/task/application/hand-over";
import type { RunHandOver } from "@/tasks/task/application/on-run-ended";
import type { TaskOutcomePort } from "@/tasks/task/application/task-outcome-port";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import { TaskEntity, type TaskStatus } from "@/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";

export const NOW = new Date("2026-10-28T12:00:00.000Z");
export const LATER = new Date("2026-10-28T12:05:00.000Z");
export const tx = {} as DbExecutor;

export const buildTask = (
  status: TaskStatus = "running",
  maxTurns: number | null = null,
  retryJson: TaskEntity["retryJson"] = null,
): TaskEntity =>
  TaskEntity.create({
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    kind: "agent",
    name: "Propose fix",
    prompt: "Fix the checkout crash.",
    maxTurns,
    retryJson,
    status,
    createdAt: NOW,
  });

export const runningRun = (task: TaskEntity): TaskRunEntity =>
  task
    .newRun({ number: 1, reason: "initial", status: "queued", now: NOW })
    .markRunning(NOW);

export const setup = (task: TaskEntity, runs: TaskRunEntity[] = []) => {
  const saved: TaskEntity[] = [];
  const taskRepo = {
    lock: vi.fn(() => Promise.resolve(task)),
    load: vi.fn(() => Promise.resolve(task)),
    save: vi.fn((next: TaskEntity) => {
      saved.push(next);
      return Promise.resolve(next);
    }),
  } as unknown as TaskRepo;
  const taskChanged = vi.fn<TaskOutcomePort["taskChanged"]>(() =>
    Promise.resolve(),
  );
  const created: TaskRunEntity[] = [];
  const taskRunRepo = {
    listByTaskId: vi.fn(() => Promise.resolve(runs)),
    create: vi.fn((run: TaskRunEntity) => {
      created.push(run);
      return Promise.resolve(run);
    }),
    clearSessions: vi.fn(() => Promise.resolve()),
  };
  const insertMessage = vi.fn(() => Promise.resolve());
  const conversationRepo = {
    create: vi.fn((conversation: ConversationEntity) =>
      Promise.resolve(conversation),
    ),
    lock: vi.fn(() => Promise.resolve(null)),
    save: vi.fn((conversation: ConversationEntity) =>
      Promise.resolve(conversation),
    ),
    insertMessage,
  } as unknown as ConversationRepo;
  const { workNotifier, enqueued } = recordingWorkNotifier();
  const createNotification = vi.fn((notification: UserNotificationEntity) =>
    Promise.resolve(notification),
  );
  const notifications = {
    notificationRepo: {
      create: createNotification,
      updateStatus: vi.fn(() => Promise.resolve()),
    },
    notificationRuleRepo: {
      listByProjectId: vi.fn(() => Promise.resolve([])),
    },
    deliveryRepo: {
      create: vi.fn(<T>(delivery: T) => Promise.resolve(delivery)),
      save: vi.fn(<T>(delivery: T) => Promise.resolve(delivery)),
    },
    adapterRegistry: { get: vi.fn(() => undefined) },
  } as unknown as HandOverDeps["notifications"];
  const deps = {
    taskRepo,
    grantRequestRepo: {
      findPendingByTaskId: vi.fn(() => Promise.resolve(null)),
      save: vi.fn(),
    },
    taskRunRepo,
    conversationRepo,
    workItemCommentRepo: { create: vi.fn() },
    taskOutcomePort: {
      taskChanged,
      taskResumed: () => Promise.resolve(),
    },
    timeProvider: fixedTimeProvider(LATER),
    taskGroup: { ended: vi.fn(() => Promise.resolve()) },
    workNotifier,
    notifications,
    managedLaunchRepo: {
      closeAllForRun: vi.fn(() => Promise.resolve(0)),
      listOperations: vi.fn(() => Promise.resolve([])),
    },
  };
  const yielded: RunHandOver = {
    message: "v1 or v2?",
    deps: {
      taskRepo,
      grantRequestRepo: { insert: vi.fn() },
      timeProvider: deps.timeProvider,
      conversationRepo,
      workItemRepo: { load: vi.fn(() => Promise.resolve(null)) },
      taskPipelineRun: {
        findForTask: vi.fn(() => Promise.resolve(null)),
        findVisitBaseBranch: vi.fn(() => Promise.resolve(null)),
      },
      notifications,
    },
  };
  return {
    deps,
    saved,
    created,
    taskChanged,
    yielded,
    insertMessage,
    enqueued,
    createNotification,
  };
};
