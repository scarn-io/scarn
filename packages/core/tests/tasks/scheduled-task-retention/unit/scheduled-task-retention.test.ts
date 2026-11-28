import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  SCHEDULED_TASK_FAILURE_RETENTION_DAYS,
  SCHEDULED_TASK_RETENTION_COUNT,
  scheduledTaskRetentionPolicy,
  selectPrunableScheduledTasks,
  type ScheduledTaskSnapshot,
} from "@/tasks/scheduled-task-retention/domain/scheduled-task-retention";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { concurrentTest } from "tests/utils";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const projectId = createUuidV7();

const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

const task = (
  scheduleId: UuidV7,
  status: TaskStatus,
  scheduledFor: Date,
  extra: Partial<ScheduledTaskSnapshot> = {},
): ScheduledTaskSnapshot => ({
  id: createUuidV7(),
  projectId,
  scheduleId,
  status,
  scheduledFor,
  hasConversation: false,
  referenced: false,
  ...extra,
});

const ids = (tasks: { id: UuidV7 }[]): (UuidV7 | undefined)[] =>
  tasks.map((t) => t.id);

describe("scheduledTaskRetentionPolicy", () => {
  concurrentTest("defaults to 50 Tasks and 7 days of failures", () => {
    expect(SCHEDULED_TASK_RETENTION_COUNT).toBe(50);
    expect(SCHEDULED_TASK_FAILURE_RETENTION_DAYS).toBe(7);
    expect(scheduledTaskRetentionPolicy(NOW)).toEqual({
      keepNewest: 50,
      keepFailedScheduledSince: daysAgo(7),
    });
  });

  concurrentTest("rejects keeping fewer than one Task", () => {
    expect(() => scheduledTaskRetentionPolicy(NOW, { keepNewest: 0 })).toThrow(
      /keepNewest/,
    );
  });
});

describe("selectPrunableScheduledTasks", () => {
  const policy = scheduledTaskRetentionPolicy(NOW, { keepNewest: 2 });

  concurrentTest(
    "keeps the newest N ended Tasks and deletes the rest, oldest first",
    () => {
      const schedule = createUuidV7();
      const tasks = [10, 11, 12, 13, 14].map((days) =>
        task(schedule, "cancelled", daysAgo(days)),
      );

      const prunable = selectPrunableScheduledTasks(tasks, policy, 100);

      expect(ids(prunable)).toEqual([tasks[4]?.id, tasks[3]?.id, tasks[2]?.id]);
      expect(prunable.every((t) => t.projectId === projectId)).toBe(true);
    },
  );

  concurrentTest(
    "never deletes a Task that hasn't ended, and doesn't count it",
    () => {
      const schedule = createUuidV7();
      const live = (
        [
          "queued",
          "running",
          "waiting_for_person",
          "waiting_for_work",
          "waiting_for_concurrency_slot",
        ] as const
      ).map((status, n) => task(schedule, status, daysAgo(30 + n)));
      const ended = [1, 2, 3].map((days) =>
        task(schedule, "cancelled", daysAgo(days)),
      );

      expect(
        ids(selectPrunableScheduledTasks([...live, ...ended], policy, 100)),
      ).toEqual([ended[2]?.id]);
    },
  );

  concurrentTest(
    "keeps the latest succeeded Task even past the newest N",
    () => {
      const schedule = createUuidV7();
      const oldSucceeded = task(schedule, "succeeded", daysAgo(20));
      const older = task(schedule, "succeeded", daysAgo(21));
      const newer = [1, 2].map((days) =>
        task(schedule, "cancelled", daysAgo(days)),
      );

      expect(
        ids(
          selectPrunableScheduledTasks(
            [oldSucceeded, older, ...newer],
            policy,
            100,
          ),
        ),
      ).toEqual([older.id]);
    },
  );

  concurrentTest("keeps failures inside the failure window", () => {
    const schedule = createUuidV7();
    const newest = [0, 0.5].map((days) =>
      task(schedule, "succeeded", daysAgo(days)),
    );
    const recentFailure = task(schedule, "failed", daysAgo(6));
    const edgeFailure = task(schedule, "failed", daysAgo(7));
    const oldFailure = task(schedule, "failed", daysAgo(8));

    expect(
      ids(
        selectPrunableScheduledTasks(
          [...newest, recentFailure, edgeFailure, oldFailure],
          policy,
          100,
        ),
      ),
    ).toEqual([oldFailure.id]);
  });

  concurrentTest(
    "keeps Tasks with a conversation or that something references",
    () => {
      const schedule = createUuidV7();
      const newest = [1, 2].map((days) =>
        task(schedule, "cancelled", daysAgo(days)),
      );
      const chat = task(schedule, "cancelled", daysAgo(10), {
        hasConversation: true,
      });
      const continued = task(schedule, "cancelled", daysAgo(11), {
        referenced: true,
      });
      const plain = task(schedule, "cancelled", daysAgo(12));

      expect(
        ids(
          selectPrunableScheduledTasks(
            [...newest, chat, continued, plain],
            policy,
            100,
          ),
        ),
      ).toEqual([plain.id]);
    },
  );

  concurrentTest(
    "ranks each schedule separately and orders across them",
    () => {
      const a = createUuidV7();
      const b = createUuidV7();
      const aTasks = [1, 2, 5].map((days) =>
        task(a, "cancelled", daysAgo(days)),
      );
      const bTasks = [1, 2, 4, 6].map((days) =>
        task(b, "cancelled", daysAgo(days)),
      );

      expect(
        ids(selectPrunableScheduledTasks([...aTasks, ...bTasks], policy, 100)),
      ).toEqual([bTasks[3]?.id, aTasks[2]?.id, bTasks[2]?.id]);
    },
  );

  concurrentTest("returns at most `limit` Tasks, the oldest", () => {
    const schedule = createUuidV7();
    const tasks = [1, 2, 3, 4, 5, 6].map((days) =>
      task(schedule, "cancelled", daysAgo(days)),
    );

    expect(ids(selectPrunableScheduledTasks(tasks, policy, 2))).toEqual([
      tasks[5]?.id,
      tasks[4]?.id,
    ]);
  });
});
