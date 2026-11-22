import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { TaskMessageEntity } from "@/tasks/task-message/domain/task-message-entity";
import type { TaskRunHistoryEntry } from "@/tasks/task-run/application/task-run-history-reader";
import type { TaskRunRepo } from "@/tasks/task-run/application/task-run-repo";
import {
  buildSteeringPromptLines,
  loadStepSteering,
} from "@/tasks/task-run/application/task-run-worker-context-steering";
import {
  AgentTaskRunEntity,
  type TaskRunReason,
  type TaskRunStatus,
} from "@/tasks/task-run/domain/task-run-entity";
import { concurrentTest, serialTest } from "tests/utils";

const projectId = createUuidV7();
const workItemId = createUuidV7();
const alex = createUuidV7();

type RunSpec = {
  status: TaskRunStatus;
  workBranch?: string | null;
  messages?: { body: string; author?: UuidV7 }[];
};

/** A chain of runs plus the repo steering reads from. */
const buildChain = (specs: RunSpec[]) => {
  const runs = specs.reduce<
    (RunSpec & { id: UuidV7; previousId: UuidV7 | null })[]
  >(
    (chain, spec) => [
      ...chain,
      { ...spec, id: createUuidV7(), previousId: chain.at(-1)?.id ?? null },
    ],
    [],
  );
  const tasks = runs.map((run) =>
    AgentTaskRunEntity.rehydrate({
      id: run.id,
      taskId: createUuidV7(),
      number: 1,
      reason: "initial",
      projectId,
      workItemId,
      prompt: "Fix the export.",
      status: run.status,
      evaluatedAt: new Date("2026-10-26T09:00:00.000Z"),
      previousTaskRunId: run.previousId,
      workBranch: run.workBranch ?? null,
      resultJson: run.status === "succeeded" ? { summary: "done" } : null,
    }),
  );
  const history: TaskRunHistoryEntry[] = runs.map((run) => ({
    taskRunId: run.id,
    previousTaskRunId: run.previousId,
    status: run.status,
    createdAt: new Date("2026-10-26T09:00:00.000Z"),
    messages: (run.messages ?? []).map((message) =>
      TaskMessageEntity.create({
        taskId: run.id,
        authorUserId: message.author ?? alex,
        body: message.body,
      }),
    ),
  }));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const taskRunRepo = {
    load: (id: UuidV7) => Promise.resolve(byId.get(id) ?? null),
    loadManyByIds: (wanted: UuidV7[]) =>
      Promise.resolve(tasks.filter((task) => wanted.includes(task.id))),
  } as unknown as TaskRunRepo;
  return { history, taskRunRepo };
};

const promptFor = async (
  specs: RunSpec[],
  reason: TaskRunReason = "initial",
  baseWorkBranch: string | null = "main",
  stepBaseBranch: string | null = null,
) => {
  const steering = await loadStepSteering({ ...buildChain(specs), reason });
  return {
    steering,
    text: buildSteeringPromptLines({
      steering,
      baseWorkBranch,
      stepBaseBranch,
    }).join("\n"),
  };
};

describe("task worker context steering: continuing a yielded run", () => {
  serialTest(
    "a continuation of a yielded run continues from its branch with no findings",
    async () => {
      const { steering, text } = await promptFor(
        [
          { status: "yielded", workBranch: "scarn/propose-fix-1" },
          { status: "running" },
        ],
        "continuation",
      );
      expect(steering.hasOwnMessage).toBe(false);
      expect(steering.continuedBranch).toEqual({
        from: "previous_run",
        workBranch: "scarn/propose-fix-1",
      });
      expect(steering.previousRun?.status).toBe("yielded");
      expect(text).toMatchSnapshot();
    },
  );

  concurrentTest(
    "a yielded run with no work branch falls back to the nearest succeeded run",
    async () => {
      const { steering } = await promptFor(
        [
          { status: "succeeded", workBranch: "scarn/propose-fix-1" },
          {
            status: "yielded",
            workBranch: null,
            messages: [{ body: "Look at the CSV job." }],
          },
          { status: "running" },
        ],
        "continuation",
      );
      expect(steering.continuedBranch).toEqual({
        from: "earlier_run",
        workBranch: "scarn/propose-fix-1",
      });
    },
  );

  concurrentTest(
    "a retry after a yielded run with no message of its own has no previous run",
    async () => {
      const { steering } = await promptFor(
        [
          { status: "yielded", workBranch: "scarn/propose-fix-1" },
          { status: "running" },
        ],
        "retry",
      );
      expect(steering.previousRun).toBeNull();
      expect(steering.continuedBranch).toBeNull();
    },
  );

  concurrentTest(
    "a run after a succeeded run with no message of its own has no previous run",
    async () => {
      const { steering, text } = await promptFor([
        {
          status: "succeeded",
          workBranch: "scarn/propose-fix-1",
          messages: [{ body: "Look at the CSV job." }],
        },
        { status: "running" },
      ]);
      expect(steering.previousRun).toBeNull();
      expect(text).toContain(
        "Earlier instructions from the user to this step, oldest first:",
      );
    },
  );

  concurrentTest(
    "a steer after a succeeded run keeps the findings line",
    async () => {
      const { text } = await promptFor([
        { status: "succeeded", workBranch: "scarn/propose-fix-1" },
        {
          status: "running",
          messages: [{ body: "Release the lock." }],
        },
      ]);
      expect(text).toContain(
        "Messages from the user to this step, oldest first:",
      );
      expect(text).toContain(
        "[1] Sent before attempt 2 (the latest; act on this one now):\n    Release the lock.",
      );
      expect(text).toContain("Its findings: .scarn/previous-run/findings.json");
      expect(text).not.toContain("so it has no findings");
    },
  );

  concurrentTest(
    "a step that sets a base branch says so, not the upstream branch",
    async () => {
      const { text } = await promptFor(
        [
          { status: "failed", messages: [{ body: "Try again." }] },
          { status: "running", messages: [{ body: "Release the lock." }] },
        ],
        "initial",
        null,
        "ephemeral-{{env.TICKET_NUMBER}}",
      );
      expect(text).toContain(
        "so your work branch starts from the step's base branch.",
      );
      expect(text).not.toContain("upstream branch");
    },
  );
});
