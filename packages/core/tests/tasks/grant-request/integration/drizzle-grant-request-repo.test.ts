import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { projects, taskGrantRequests, taskRuns } from "@/lib/db/schema";
import {
  newGrantRequest,
  type GrantRequest,
} from "@/tasks/grant-request/domain/grant-request";
import { DrizzleGrantRequestRepo } from "@/tasks/grant-request/infra/drizzle-grant-request-repo";
import type { Grant } from "@/tasks/task/domain/grants";
import { concurrentTest } from "tests/utils";
import v1Decided from "../fixtures/v1-decided.json";
import {
  insertStoredTask,
  seedStoredTaskOwners,
  storedTaskFixtures,
  type StoredTaskOwners,
} from "../../task/integration/stored-task-fixtures";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const LATER = new Date("2026-11-26T13:00:00.000Z");

const requested: Grant[] = [
  {
    resource: "workItem",
    action: "label",
    scope: "children",
    labels: ["frontend"],
  },
  { resource: "workItem", action: "comment", scope: "self" },
];

type Seeded = StoredTaskOwners & { taskId: UuidV7; taskRunId: UuidV7 };

const withYieldedTask = async (run: (seeded: Seeded) => Promise<void>) => {
  const owners = await seedStoredTaskOwners();
  try {
    const taskId = await insertStoredTask(owners, {
      ...storedTaskFixtures.agent,
      status: "waiting_for_person",
    });
    const taskRunId = createUuidV7();
    await getDb().insert(taskRuns).values({
      id: taskRunId,
      taskId,
      number: 1,
      reason: "initial",
      projectId: owners.projectId,
      workItemId: owners.workItemId,
      status: "yielded",
      completedAt: NOW,
    });
    await run({ ...owners, taskId, taskRunId });
  } finally {
    await getDb().delete(projects).where(eq(projects.id, owners.projectId));
  }
};

const pendingFor = (seeded: Seeded): GrantRequest =>
  newGrantRequest({
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    taskRunId: seeded.taskRunId,
    reason: "I need to label the children I created.",
    requested,
    now: NOW,
  });

const rejectionOf = async <T>(promise: Promise<T>) => {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
};

describe("DrizzleGrantRequestRepo", () => {
  const repo = new DrizzleGrantRequestRepo();

  concurrentTest("inserts a request and loads it by id", () =>
    withYieldedTask(async (seeded) => {
      const request = pendingFor(seeded);
      expect(await repo.insert(request)).toEqual(request);
      expect(await repo.load(request.id)).toEqual(request);
      expect(await repo.load(createUuidV7())).toBeNull();
    }),
  );

  concurrentTest("finds a Task's pending request", () =>
    withYieldedTask(async (seeded) => {
      const request = await repo.insert(pendingFor(seeded));
      const found = await getDb().transaction((tx) =>
        repo.findPendingByTaskId(seeded.taskId, tx),
      );
      expect(found).toEqual(request);

      await repo.save({ ...request, status: "unanswered" });
      const none = await getDb().transaction((tx) =>
        repo.findPendingByTaskId(seeded.taskId, tx),
      );
      expect(none).toBeNull();
    }),
  );

  concurrentTest("saves a decision", () =>
    withYieldedTask(async (seeded) => {
      const request = await repo.insert(pendingFor(seeded));
      const deciderId = createUuidV7();
      const decided: GrantRequest = {
        ...request,
        status: "decided",
        approved: [requested[1] as Grant],
        note: "Only the comment.",
        decidedByUserId: deciderId,
        decidedAt: LATER,
      };
      expect(await repo.save(decided)).toEqual(decided);
      expect(await repo.load(request.id)).toEqual(decided);

      const denied: GrantRequest = { ...decided, approved: [] };
      expect((await repo.save(denied)).approved).toEqual([]);
    }),
  );

  concurrentTest("refuses a second pending request for the same Task", () =>
    withYieldedTask(async (seeded) => {
      const first = await repo.insert(pendingFor(seeded));
      expect(await rejectionOf(repo.insert(pendingFor(seeded)))).toMatchObject({
        code: "GRANT_REQUEST_ALREADY_PENDING",
        status: 409,
      });

      await repo.save({ ...first, status: "withdrawn" });
      const second = await repo.insert(pendingFor(seeded));
      expect(second.status).toBe("pending");
    }),
  );

  concurrentTest("reads the v1 decided fixture through the repo", () =>
    withYieldedTask(async (seeded) => {
      const id = createUuidV7();
      await getDb().insert(taskGrantRequests).values({
        id,
        projectId: seeded.projectId,
        taskId: seeded.taskId,
        taskRunId: seeded.taskRunId,
        reason: v1Decided.reason,
        requestedJson: v1Decided.requestedJson,
        status: "decided",
        approvedJson: v1Decided.approvedJson,
        note: v1Decided.note,
        decidedByUserId: createUuidV7(),
        decidedAt: LATER,
        schemaVersion: v1Decided.schemaVersion,
        createdAt: NOW,
      });
      const read = await repo.load(id);
      expect(read?.requested as unknown).toEqual(v1Decided.requestedJson);
      expect(read?.approved as unknown).toEqual(v1Decided.approvedJson);
    }),
  );

  concurrentTest("an unreadable row throws on load", () =>
    withYieldedTask(async (seeded) => {
      const id = createUuidV7();
      await getDb().insert(taskGrantRequests).values({
        id,
        projectId: seeded.projectId,
        taskId: seeded.taskId,
        taskRunId: seeded.taskRunId,
        reason: "Example reason.",
        requestedJson: requested,
        status: "decided",
        approvedJson: [],
        schemaVersion: 99,
        createdAt: NOW,
      });
      expect(await rejectionOf(repo.load(id))).toMatchObject({
        code: "TASK_GRANT_REQUEST_ROW_UNREADABLE",
      });
    }),
  );
});
