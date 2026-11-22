import { describe, expect, test, vi } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { StepDefinitionEntity } from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import {
  TaskGroup,
  ConcurrencyGroupFullError,
  type TaskGroupDeps,
} from "@/tasks/task/application/task-group";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { buildTask, tx } from "./on-run-ended-fixtures";

const setup = (holding: TaskEntity[]) => {
  const step = StepDefinitionEntity.create({
    projectId: createUuidV7(),
    key: "fix",
    name: "Fix",
    prompt: "Fix it",
    version: 1,
    kind: "user_defined",
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    taskExecutionConfigId: createUuidV7(),
    status: "active",
    concurrency: { max: 1, waiting: 10 },
  });
  const task = TaskEntity.rehydrate({
    ...buildTask("failed").toJSON(),
    stepDefinitionId: step.id,
  });
  const lockConcurrencyGroup = vi.fn(() => Promise.resolve());
  const deps = {
    taskRepo: {
      lockConcurrencyGroup,
      listLiveInConcurrencyGroup: vi.fn(() => Promise.resolve(holding)),
    },
    stepDefinitionRepo: { load: vi.fn(() => Promise.resolve(step)) },
  } as unknown as TaskGroupDeps;
  return { group: new TaskGroup(deps), task, lockConcurrencyGroup };
};

describe("TaskGroup.reacquire", () => {
  test.concurrent("reacquires under the same advisory group lock", async () => {
    const { group, task, lockConcurrencyGroup } = setup([]);
    await group.reacquire(task, tx);
    expect(lockConcurrencyGroup).toHaveBeenCalledWith(
      {
        projectId: task.projectId,
        workItemId: task.workItemId,
        stepKey: "fix",
      },
      tx,
    );
  });

  test.concurrent(
    "does not defer even when the step has waiting room",
    async () => {
      const holder = buildTask("running");
      const { group, task } = setup([holder]);
      let failure: Error | undefined;
      try {
        await group.reacquire(task, tx);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConcurrencyGroupFullError);
      expect(failure).toMatchObject({ heldBy: [holder.id] });
    },
  );

  test.concurrent("slot-waiting Tasks do not hold a place", async () => {
    const { group, task } = setup([buildTask("waiting_for_concurrency_slot")]);
    await group.reacquire(task, tx);
  });

  test.concurrent("a task without a step skips the group", async () => {
    const { group, lockConcurrencyGroup } = setup([]);
    await group.reacquire(buildTask("failed"), tx);
    expect(lockConcurrencyGroup).not.toHaveBeenCalled();
  });
});
