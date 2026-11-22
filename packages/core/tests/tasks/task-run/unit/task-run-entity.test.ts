import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  AgentTaskRunEntity,
  CodeTaskRunEntity,
  TaskRunEntity,
  taskRunStatusForResult,
} from "@/tasks/task-run/domain/task-run-entity";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

function buildRunningTask(input?: {
  executionDeadlineAt?: Date | null;
  leaseExpiresAt?: Date | null;
  evaluatedAt?: Date;
}) {
  return AgentTaskRunEntity.rehydrate({
    id: createUuidV7(),
    taskId: createUuidV7(),
    number: 1,
    reason: "initial",
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    taskExecutionConfigId: createUuidV7(),
    prompt: "Return a result payload.",
    status: "running",
    evaluatedAt: input?.evaluatedAt ?? new Date("2026-05-01T10:00:15.000Z"),
    claimedBy: "worker-a",
    claimToken: crypto.randomUUID(),
    claimedAt: new Date("2026-05-01T10:00:00.000Z"),
    lastHeartbeatAt: new Date("2026-05-01T10:00:10.000Z"),
    leaseExpiresAt:
      input?.leaseExpiresAt ?? new Date("2026-05-01T10:00:40.000Z"),
    executionTimeoutSeconds: 120,
    executionDeadlineAt:
      input?.executionDeadlineAt ?? new Date("2026-05-01T10:02:00.000Z"),
    startedAt: new Date("2026-05-01T10:00:00.000Z"),
    createdAt: new Date("2026-05-01T09:59:00.000Z"),
    updatedAt: new Date("2026-05-01T10:00:10.000Z"),
  });
}

describe("task entity derived liveness status", () => {
  concurrentTest("derives timeout when execution deadline has passed", () => {
    const task = buildRunningTask({
      evaluatedAt: new Date("2026-05-01T10:02:01.000Z"),
    });

    // The getter derives status from the entity's own clocks; the raw column
    // value is untouched (`persistedStatus` stays `running`) and the claim is
    // NOT cleared — derivation is pure and never mutates persisted state.
    expect(task.status).toBe("timeout");
    expect(task.persistedStatus).toBe("running");
    expect(task.claimedBy).toBe("worker-a");
  });

  concurrentTest("derives abandoned when lease expires before deadline", () => {
    const task = buildRunningTask({
      executionDeadlineAt: new Date("2026-05-01T10:05:00.000Z"),
      leaseExpiresAt: new Date("2026-05-01T10:00:20.000Z"),
      evaluatedAt: new Date("2026-05-01T10:00:21.000Z"),
    });

    expect(task.status).toBe("abandoned");
    expect(task.persistedStatus).toBe("running");
  });

  concurrentTest(
    "timeout wins when both lease and deadline have lapsed",
    () => {
      const task = buildRunningTask({
        executionDeadlineAt: new Date("2026-05-01T10:00:20.000Z"),
        leaseExpiresAt: new Date("2026-05-01T10:00:10.000Z"),
        evaluatedAt: new Date("2026-05-01T10:00:30.000Z"),
      });

      expect(task.status).toBe("timeout");
    },
  );

  concurrentTest(
    "keeps running when lease and deadline are still valid",
    () => {
      const task = buildRunningTask({
        evaluatedAt: new Date("2026-05-01T10:00:30.000Z"),
      });

      expect(task.status).toBe("running");
      expect(task.claimedBy).toBe("worker-a");
    },
  );
});

describe("task entity completion", () => {
  concurrentTest("maps result status to a terminal step status", () => {
    expect(taskRunStatusForResult("succeeded")).toBe("succeeded");
    expect(taskRunStatusForResult("failed")).toBe("failed");
  });

  concurrentTest(
    "transitions preserve the task's kind and instructions",
    () => {
      const now = new Date("2026-05-01T10:01:00.000Z");
      const completed = buildRunningTask().complete("succeeded", now, {
        resultJson: { ok: true },
      });

      expect(completed).toBeInstanceOf(AgentTaskRunEntity);
      expect(completed.prompt).toBe("Return a result payload.");
    },
  );

  concurrentTest(
    "completing a succeeded step stamps completion and clears the claim",
    () => {
      const now = new Date("2026-05-01T10:01:00.000Z");
      const completed = buildRunningTask().complete("succeeded", now, {
        resultJson: { ok: true },
      });

      expect(completed.status).toBe("succeeded");
      expect(completed.completedAt?.toISOString()).toBe(now.toISOString());
      expect(completed.claimedBy).toBeNull();
      expect(completed.claimToken).toBeNull();
      expect(completed.leaseExpiresAt).toBeNull();
    },
  );

  concurrentTest(
    "completing a failed step yields the failed terminal status",
    () => {
      const now = new Date("2026-05-01T10:01:00.000Z");
      const completed = buildRunningTask().complete("failed", now, {
        resultJson: { ok: true },
      });

      expect(completed.status).toBe("failed");
      expect(completed.completedAt?.toISOString()).toBe(now.toISOString());
      expect(completed.claimedBy).toBeNull();
    },
  );
});

describe("task entity write-path safety (persistedStatus only)", () => {
  // The repository persists `persistedStatus`, never the derived `status` getter.
  // These tests pin the load-bearing property from the plan's "critical fix":
  // the overlay must NEVER reach a write, or a save of a lapsed entity would
  // corrupt `task_runs.status` (e.g. persist `abandoned` over `succeeded`).

  concurrentTest(
    "toJSON (the row mapper source) emits the raw status, not the overlay",
    () => {
      // Lease-lapsed running step: getter derives `abandoned`, column stays `running`.
      const lapsed = buildRunningTask({
        leaseExpiresAt: new Date("2026-05-01T10:00:20.000Z"),
        executionDeadlineAt: new Date("2026-05-01T10:05:00.000Z"),
        evaluatedAt: new Date("2026-05-01T10:00:30.000Z"),
      });

      expect(lapsed.status).toBe("abandoned");
      expect(lapsed.persistedStatus).toBe("running");
      // `toTaskRow` reads `persistedStatus`, which flows from `toJSON`.
      expect(lapsed.toJSON().status).toBe("running");
    },
  );

  concurrentTest(
    "completing a lapsed-lease step persists succeeded, never abandoned",
    () => {
      const now = new Date("2026-05-01T10:00:31.000Z");
      // A step whose lease has lapsed (getter would say `abandoned`) that the
      // worker is nonetheless completing successfully in the same request.
      const lapsed = buildRunningTask({
        leaseExpiresAt: new Date("2026-05-01T10:00:20.000Z"),
        executionDeadlineAt: new Date("2026-05-01T10:05:00.000Z"),
        evaluatedAt: now,
      });
      expect(lapsed.status).toBe("abandoned");

      const completed = lapsed.complete("succeeded", now, {
        resultJson: { ok: true },
      });

      // The transition operates on the raw status; the completed step is a real
      // terminal `succeeded` and the getter's `running` guard no longer re-overlays.
      expect(completed.status).toBe("succeeded");
      expect(completed.persistedStatus).toBe("succeeded");
      expect(completed.toJSON().status).toBe("succeeded");
    },
  );
});

describe("task entity per-kind invariants", () => {
  const baseProps = () => ({
    taskId: createUuidV7(),
    number: 1,
    reason: "initial" as const,
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    taskExecutionConfigId: createUuidV7(),
    status: "queued" as const,
    evaluatedAt: new Date("2026-05-01T10:00:00.000Z"),
  });

  const expectValidationCode = (build: () => unknown, code: string) => {
    try {
      build();
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(code);
      return;
    }
    throw new Error(`Expected CoreValidationError ${code}`);
  };

  concurrentTest("creates an AgentTaskRunEntity with a trimmed prompt", () => {
    const task = TaskRunEntity.create({
      ...baseProps(),
      kind: "agent",
      prompt: "  Triage the ticket.  ",
    });

    expect(task).toBeInstanceOf(AgentTaskRunEntity);
    expect(task.kind === "agent" && task.prompt).toBe("Triage the ticket.");
    expect(task.toJSON().entrypointJson).toBeNull();
  });

  concurrentTest("creates a CodeTaskRunEntity with an entrypoint", () => {
    const task = TaskRunEntity.create({
      ...baseProps(),
      kind: "code",
      entrypointJson: { sourceFile: "steps/triage.ts" },
    });

    expect(task).toBeInstanceOf(CodeTaskRunEntity);
    expect(task.kind === "code" && task.entrypointJson).toEqual({
      sourceFile: "steps/triage.ts",
    });
    expect(task.toJSON().prompt).toBeNull();
  });

  concurrentTest("rejects an agent task with a blank prompt", () => {
    expectValidationCode(
      () => AgentTaskRunEntity.create({ ...baseProps(), prompt: "  " }),
      "TASK_PROMPT_REQUIRED",
    );
  });

  concurrentTest("rejects a code task with a blank entrypoint", () => {
    expectValidationCode(
      () =>
        CodeTaskRunEntity.create({
          ...baseProps(),
          entrypointJson: { sourceFile: " " },
        }),
      "TASK_ENTRYPOINT_REQUIRED",
    );
  });

  describe("rehydrating a flat row", () => {
    const row = () => ({ ...baseProps(), id: createUuidV7() });

    concurrentTest("rejects an agent row without a prompt", () => {
      expectValidationCode(
        () =>
          TaskRunEntity.rehydrate({ ...row(), kind: "agent", prompt: null }),
        "TASK_PROMPT_REQUIRED",
      );
    });

    concurrentTest("rejects an agent row with an entrypoint", () => {
      expectValidationCode(
        () =>
          TaskRunEntity.rehydrate({
            ...row(),
            kind: "agent",
            prompt: "Triage the ticket.",
            entrypointJson: { sourceFile: "steps/triage.ts" },
          }),
        "TASK_ENTRYPOINT_NOT_ALLOWED",
      );
    });

    concurrentTest("rejects a code row without an entrypoint", () => {
      expectValidationCode(
        () => TaskRunEntity.rehydrate({ ...row(), kind: "code" }),
        "TASK_ENTRYPOINT_REQUIRED",
      );
    });

    concurrentTest("rejects a code row with a prompt", () => {
      expectValidationCode(
        () =>
          TaskRunEntity.rehydrate({
            ...row(),
            kind: "code",
            prompt: "Triage the ticket.",
            entrypointJson: { sourceFile: "steps/triage.ts" },
          }),
        "TASK_PROMPT_NOT_ALLOWED",
      );
    });
  });
});

describe("task entity previous run", () => {
  const baseProps = () => ({
    taskId: createUuidV7(),
    number: 1,
    reason: "initial" as const,
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    status: "queued" as const,
    evaluatedAt: new Date("2026-05-01T10:00:00.000Z"),
  });

  concurrentTest(
    "defaults to no previous run and keeps it through transitions",
    () => {
      const previousTaskRunId = createUuidV7();
      const first = TaskRunEntity.create({
        ...baseProps(),
        kind: "agent",
        prompt: "Investigate.",
      });
      const linked = TaskRunEntity.create({
        ...baseProps(),
        kind: "code",
        entrypointJson: { sourceFile: "steps/triage.ts" },
        previousTaskRunId,
      });

      expect(first.previousTaskRunId).toBeNull();
      expect(linked.previousTaskRunId).toBe(previousTaskRunId);
      expect(linked.toJSON().previousTaskRunId).toBe(previousTaskRunId);
      expect(
        linked.markRunning(new Date("2026-05-01T10:01:00.000Z"))
          .previousTaskRunId,
      ).toBe(previousTaskRunId);
    },
  );
});
