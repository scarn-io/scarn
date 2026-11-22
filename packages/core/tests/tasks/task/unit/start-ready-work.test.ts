import { describe, expect, test, vi } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import {
  startReadyWork,
  type StartReadyWorkDeps,
} from "@/tasks/task/application/start-ready-work";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import type { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { WorkItemBlockRepo } from "@/work-items/work-item-block/application/work-item-block-repo";
import { fixedTimeProvider } from "tests/utils";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import { buildTask, NOW, tx } from "./on-run-ended-fixtures";

const workItemOf = (task: TaskEntity): UuidV7 => {
  if (task.workItemId === null) {
    throw new Error(`Task ${task.id} has no work item`);
  }
  return task.workItemId;
};

const setup = (waiting: TaskEntity[], blockedWorkItemIds: string[]) => {
  const { workNotifier, enqueued } = recordingWorkNotifier();
  const created: TaskRunEntity[] = [];
  const deps: StartReadyWorkDeps = {
    taskRepo: {
      lockWaitingForWorkByWorkItemIds: vi.fn(() => Promise.resolve(waiting)),
      save: vi.fn((task: TaskEntity) => Promise.resolve(task)),
    } as unknown as TaskRepo,
    taskRunRepo: {
      listByTaskId: vi.fn(() => Promise.resolve([])),
      create: vi.fn((run: TaskRunEntity) => {
        created.push(run);
        return Promise.resolve(run);
      }),
    } as unknown as TaskRunRepo,
    workItemBlockRepo: {
      listIdsWithOpenBlockers: vi.fn(() => Promise.resolve(blockedWorkItemIds)),
    } as unknown as WorkItemBlockRepo,
    timeProvider: fixedTimeProvider(NOW),
    workNotifier,
  };
  return { deps, enqueued, created };
};

describe("startReadyWork notifying workers", () => {
  test("each run queued for a now-ready Task tells the notifier its project", async () => {
    const ready = buildTask("waiting_for_work");
    const stillBlocked = buildTask("waiting_for_work");
    const { deps, enqueued, created } = setup(
      [ready, stillBlocked],
      [workItemOf(stillBlocked)],
    );

    await startReadyWork(
      [workItemOf(ready), workItemOf(stillBlocked)],
      deps,
      tx,
    );

    expect(created.map((run) => run.taskId)).toEqual([ready.id]);
    expect(enqueued).toEqual([ready.projectId]);
  });
});
