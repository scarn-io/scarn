import { describe, expect, test, vi } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { Result } from "@/lib/result";
import {
  startTask,
  type StandaloneTaskSpec,
  type StartTaskDeps,
} from "@/tasks/task/application/start-task-from-step-definition";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import type { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import type { WorkItemBlockRepo } from "@/work-items/work-item-block/application/work-item-block-repo";
import { fixedTimeProvider } from "tests/utils";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import { NOW, tx } from "./on-run-ended-fixtures";

const spec: StandaloneTaskSpec = {
  kind: "agent",
  prompt: "Fix the checkout crash.",
  name: null,
  resultSchemaJson: null,
  taskExecutionConfigId: null,
  stepDefinitionId: null,
  retryJson: null,
  grants: [],
  maxTurns: 3,
  concurrencyGroup: null,
};

const setup = (openBlockers: string[]) => {
  const { workNotifier, enqueued } = recordingWorkNotifier();
  const deps: StartTaskDeps = {
    taskRepo: {
      create: vi.fn((task: TaskEntity) => Promise.resolve(task)),
    } as unknown as TaskRepo,
    taskRunRepo: {
      create: vi.fn((run: TaskRunEntity) => Promise.resolve(run)),
    } as unknown as TaskRunRepo,
    workItemBlockRepo: {
      listIdsWithOpenBlockers: vi.fn(() => Promise.resolve(openBlockers)),
    } as unknown as WorkItemBlockRepo,
    taskGroup: { arrive: vi.fn() },
    timeProvider: fixedTimeProvider(NOW),
    workNotifier,
  };
  return { deps, enqueued };
};

const start = (projectId = createUuidV7()) => ({
  projectId,
  workItemId: createUuidV7(),
  inputJson: null,
  executionTimeoutSeconds: null,
  startedByUserId: null,
});

describe("startTask notifying workers", () => {
  test("a ready work item's initial run tells the notifier its project", async () => {
    const { deps, enqueued } = setup([]);
    const projectId = createUuidV7();

    const { run } = Result.unwrap(
      await startTask(spec, start(projectId), deps, tx),
    );

    expect(run?.status).toBe("queued");
    expect(enqueued).toEqual([projectId]);
  });

  test("the Task copies the spec's log setting, else always", async () => {
    const { deps } = setup([]);

    const { task: plain } = Result.unwrap(
      await startTask(spec, start(), deps, tx),
    );
    const { task: skipping } = Result.unwrap(
      await startTask({ ...spec, logArchive: "on-failure" }, start(), deps, tx),
    );

    expect(plain.logArchive).toBe("always");
    expect(skipping.logArchive).toBe("on-failure");
  });

  test("a blocked work item queues no run and tells the notifier nothing", async () => {
    const { deps, enqueued } = setup([createUuidV7()]);

    const { run } = Result.unwrap(await startTask(spec, start(), deps, tx));

    expect(run).toBeNull();
    expect(enqueued).toEqual([]);
  });
});
