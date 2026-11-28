import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  TaskEntity,
  type CreateTaskEntityProps,
} from "@/tasks/task/domain/task-entity";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import { NOW } from "./on-run-ended-fixtures";

const LATER = new Date(NOW.getTime() + 60_000);

const promptTask = (overrides: Partial<CreateTaskEntityProps> = {}) =>
  TaskEntity.create({
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    kind: "agent",
    prompt: "Triage the item.",
    status: "queued",
    startedByUserId: createUuidV7(),
    createdAt: NOW,
    ...overrides,
  });

describe("whether a Task's agent may ask for grants", () => {
  test.concurrent(
    "a person's prompt Task on a work item may ask",
    () => {
      expect(promptTask().grantRequests).toBe(true);
    },
  );

  test.concurrent(
    "a step Task may ask only when its step declares grantRequests",
    () => {
      const stepDefinitionId = createUuidV7();

      expect(
        promptTask({ stepDefinitionId, stepGrantRequests: true }).grantRequests,
      ).toBe(true);
      expect(
        promptTask({ stepDefinitionId, stepGrantRequests: false })
          .grantRequests,
      ).toBe(false);
      expect(promptTask({ stepDefinitionId }).grantRequests).toBe(false);
    },
  );

  test.concurrent("a Task no person started may not ask", () => {
    expect(promptTask({ startedByUserId: null }).grantRequests).toBe(false);
  });

  test.concurrent("a Task an automation started may not ask", () => {
    expect(
      promptTask({ startedByAutomationId: createUuidV7() }).grantRequests,
    ).toBe(false);
  });

  test.concurrent("a scheduled Task may not ask", () => {
    expect(
      promptTask({
        workItemId: null,
        startedByScheduleId: createUuidV7(),
        scheduledFor: NOW,
      }).grantRequests,
    ).toBe(false);
  });

  test.concurrent("a chat Task with no work item may not ask", () => {
    expect(
      promptTask({
        workItemId: null,
        conversationId: createUuidV7(),
      }).grantRequests,
    ).toBe(false);
  });

  test.concurrent("code and MCP tool Tasks may not ask", () => {
    const stepDefinitionId = createUuidV7();
    const code = promptTask({
      kind: "code",
      prompt: null,
      entrypointJson: { sourceFile: "steps/run.ts" },
      stepDefinitionId,
      stepGrantRequests: true,
    });
    const tool = promptTask({
      kind: "mcp_tool",
      prompt: null,
      toolCallJson: {
        server: "notion",
        tool: "search",
        argsTemplate: {},
        toolSchemas: { input: { type: "object" }, output: null },
      },
      stepDefinitionId,
      stepGrantRequests: true,
    });

    expect(code.grantRequests).toBe(false);
    expect(tool.grantRequests).toBe(false);
  });
});

describe("a Task's grants that grow", () => {
  test.concurrent("added grants join the Task's grants", () => {
    const task = promptTask();

    const grown = task.withGrants(
      [{ resource: "workItem", action: "comment", scope: "self" }],
      LATER,
    );

    expect(grown.grants).toEqual([
      { resource: "workItem", action: "read", scope: "self" },
      { resource: "workItem", action: "comment", scope: "self" },
    ]);
    expect(grown.updatedAt).toEqual(LATER);
  });

  test.concurrent(
    "a grant already held for the same action and scope merges its labels",
    () => {
      const task = promptTask({
        grants: [
          {
            resource: "workItem",
            action: "label",
            scope: "self",
            labels: ["bug", "triaged"],
          },
        ],
      });

      const grown = task.withGrants(
        [
          {
            resource: "workItem",
            action: "label",
            scope: "self",
            labels: ["triaged", "urgent"],
          },
          { resource: "workItem", action: "read", scope: "self" },
        ],
        LATER,
      );

      expect(grown.grants).toEqual([
        { resource: "workItem", action: "read", scope: "self" },
        {
          resource: "workItem",
          action: "label",
          scope: "self",
          labels: ["bug", "triaged", "urgent"],
        },
      ]);
    },
  );

  test.concurrent(
    "project grants with different key prefixes stay separate",
    () => {
      const task = promptTask({
        grants: [
          {
            resource: "workItem",
            action: "create",
            scope: "project",
            keyPrefix: "SEC-",
            labels: ["security"],
          },
        ],
      });

      const grown = task.withGrants(
        [
          {
            resource: "workItem",
            action: "create",
            scope: "project",
            keyPrefix: "OPS-",
            labels: ["ops"],
          },
          {
            resource: "workItem",
            action: "create",
            scope: "project",
            keyPrefix: "SEC-",
            labels: ["cve"],
          },
        ],
        LATER,
      );

      expect(grown.grants.filter((g) => g.action === "create")).toEqual([
        {
          resource: "workItem",
          action: "create",
          scope: "project",
          keyPrefix: "SEC-",
          labels: ["security", "cve"],
        },
        {
          resource: "workItem",
          action: "create",
          scope: "project",
          keyPrefix: "OPS-",
          labels: ["ops"],
        },
      ]);
    },
  );

  test.concurrent(
    "an update grant on project naming no labels stays unlimited",
    () => {
      const task = promptTask({
        grants: [{ resource: "workItem", action: "update", scope: "project" }],
      });

      const grown = task.withGrants(
        [
          {
            resource: "workItem",
            action: "update",
            scope: "project",
            labels: ["bug"],
          },
        ],
        LATER,
      );

      expect(grown.grants.find((g) => g.action === "update")).toEqual({
        resource: "workItem",
        action: "update",
        scope: "project",
      });
    },
  );
});

describe("a Task's held work item changes", () => {
  const workItemId = createUuidV7();
  const comment: WorkItemChange = {
    kind: "comment",
    workItemId,
    body: "Looking into it.",
  };
  const label: WorkItemChange = {
    kind: "label",
    workItemId,
    add: ["triaged"],
  };

  test.concurrent("a new Task holds none", () => {
    expect(promptTask().heldWorkItemChanges).toEqual([]);
  });

  test.concurrent("held changes append in order", () => {
    const task = promptTask()
      .holdWorkItemChanges([comment], NOW)
      .holdWorkItemChanges([label], LATER);

    expect(task.heldWorkItemChanges).toEqual([comment, label]);
    expect(task.updatedAt).toEqual(LATER);
  });

  test.concurrent("clearing empties them", () => {
    const task = promptTask().holdWorkItemChanges([comment, label], NOW);

    const cleared = task.clearHeldWorkItemChanges(LATER);

    expect(cleared.heldWorkItemChanges).toEqual([]);
    expect(cleared.updatedAt).toEqual(LATER);
  });
});
