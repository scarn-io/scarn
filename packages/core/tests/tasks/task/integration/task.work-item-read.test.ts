import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import { grant } from "tests/tasks/task/grants-test-support";

type AuthHeaders = { authorization: string };

/**
 * The live read an agent's `scarn-get-work-item` makes
 * (`POST /task-runs/:id/work-item-reads`): the item's labels, and each
 * blocker's and child's labels, closure, open blockers and newest Task's
 * status.
 */
describe("task run live work item read", () => {
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
      }),
    ),
  );
  let projectId: UuidV7 | undefined;
  let headers: AuthHeaders | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-work-item-read-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Work Item Read Project",
          description: "Project for live work item read tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  const requireSetup = () => {
    if (!projectId || !headers) {
      throw new Error("Expected setup to complete");
    }
    return { projectId, headers: { ...headers } };
  };

  const createStep = async (
    children: boolean,
    grants = children ? [grant("read", "children")] : [],
  ) => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: `task_work_item_read_${crypto.randomUUID()}`,
          name: "Read step",
          description: "Step for live work item read tests",
          prompt: "Plan the children.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants,
        },
        { headers },
      ),
    );
    return { id: parseUuidV7(created.id), version: created.version };
  };

  const startTask = async (
    workItemId: UuidV7,
    step: { id: UuidV7; version: number },
  ) =>
    await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId: requireSetup().projectId,
          workItemId,
          stepDefinitionId: step.id,
          stepDefinitionVersion: step.version,
        },
        { headers: requireSetup().headers },
      ),
    );

  const block = async (blockedWorkItemId: UuidV7, blockingWorkItemId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["work-item-blocks"].post(
        {
          blockedWorkItemId: parseWorkItemId(blockedWorkItemId),
          blockingWorkItemId: parseWorkItemId(blockingWorkItemId),
        },
        { headers: requireSetup().headers },
      ),
    );

  const close = async (
    workItemId: UuidV7,
    reason: "completed" | "out_of_scope",
    resolution: string | null,
  ) =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).state.put(
        { state: "closed", reason, resolution },
        { headers: requireSetup().headers },
      ),
    );

  const update = async (
    workItemId: UuidV7,
    values: { parentWorkItemId?: UuidV7; labels?: string[] },
  ) => {
    await getDb()
      .update(workItems)
      .set(values)
      .where(eq(workItems.id, workItemId));
  };

  const claimRun = async (workItemId: UuidV7, taskRunId: UuidV7) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `work-item-read-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claim = claims.find((entry) => entry.task.id === taskRunId);
    if (!claim) {
      throw new Error(`Expected to claim run ${taskRunId}`);
    }
    return claim;
  };

  concurrentTest(
    "children and blockers carry their labels, closure, open blockers and newest Task's status",
    async () => {
      const { projectId } = requireSetup();
      const [readStep, otherStep] = await Promise.all([
        createStep(true),
        createStep(false),
      ]);
      const [item, blocker, child, sibling, childBlocker] = await Promise.all([
        seedWorkItem(projectId),
        seedWorkItem(projectId),
        seedWorkItem(projectId),
        seedWorkItem(projectId),
        seedWorkItem(projectId),
      ]);
      await Promise.all([
        update(item, { labels: ["wayfinder", "frontend"] }),
        update(child, { parentWorkItemId: item, labels: ["frontend"] }),
        update(sibling, { parentWorkItemId: item }),
        update(childBlocker, { parentWorkItemId: item }),
      ]);
      await block(item, blocker);
      await block(child, childBlocker);
      await block(child, sibling);
      await close(sibling, "completed", "Done in #3");
      await close(blocker, "out_of_scope", null);
      await startTask(childBlocker, otherStep);

      const created = await startTask(item, readStep);
      if (!created.run) {
        throw new Error("Expected the Task's first run");
      }
      const claim = await claimRun(item, parseUuidV7(created.run.id));
      const read = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
          "work-item-reads"
        ].post({
          claimToken: claim.claimToken,
          workItemId: parseWorkItemId(item),
        }),
      );

      expect(read.labels).toEqual(["wayfinder", "frontend"]);
      expect(read.blockers).toHaveLength(1);
      expect(read.blockers[0]).toMatchObject({
        id: blocker,
        state: "closed",
        closeReason: "out_of_scope",
        resolution: null,
        labels: [],
        blockedBy: [],
        latestTaskStatus: null,
      });
      const children = new Map(read.children.map((entry) => [entry.id, entry]));
      expect([...children.keys()].map(String).sort()).toEqual(
        [child, sibling, childBlocker].map(String).sort(),
      );
      expect(children.get(parseWorkItemId(child))).toMatchObject({
        labels: ["frontend"],
        state: "open",
        closeReason: null,
        resolution: null,
        blockedBy: [childBlocker],
        latestTaskStatus: null,
      });
      expect(children.get(parseWorkItemId(sibling))).toMatchObject({
        state: "closed",
        closeReason: "completed",
        resolution: "Done in #3",
        blockedBy: [],
      });
      expect(children.get(parseWorkItemId(childBlocker))).toMatchObject({
        blockedBy: [],
        latestTaskStatus: "queued",
      });
    },
    30_000,
  );

  const readAs = async (
    step: { id: UuidV7; version: number },
    item: UuidV7,
    target: UuidV7,
  ) => {
    const created = await startTask(item, step);
    if (!created.run) {
      throw new Error("Expected the Task's first run");
    }
    const claim = await claimRun(item, parseUuidV7(created.run.id));
    return await apiClient.api["task-runs"]({ taskRunId: claim.task.id })[
      "work-item-reads"
    ].post({
      claimToken: claim.claimToken,
      workItemId: parseWorkItemId(target),
    });
  };

  concurrentTest(
    "a read grant on project reads the parent and a sibling; without it they are refused",
    async () => {
      const { projectId } = requireSetup();
      const [projectStep, selfStep] = await Promise.all([
        createStep(false, [grant("read", "project")]),
        createStep(false),
      ]);
      const [parent, item, sibling, otherItem] = await Promise.all([
        seedWorkItem(projectId),
        seedWorkItem(projectId),
        seedWorkItem(projectId),
        seedWorkItem(projectId),
      ]);
      await Promise.all([
        update(item, { parentWorkItemId: parent }),
        update(sibling, { parentWorkItemId: parent }),
        update(otherItem, { parentWorkItemId: parent }),
      ]);

      const parentRead = await readAs(projectStep, item, parent);
      expect(parentRead.error).toBeNull();
      expect(parentRead.data?.id).toBe(parseWorkItemId(parent));

      const siblingRead = await readAs(projectStep, sibling, otherItem);
      expect(siblingRead.error).toBeNull();
      expect(siblingRead.data?.id).toBe(parseWorkItemId(otherItem));

      const refused = await readAs(selfStep, otherItem, sibling);
      expect(refused.error?.status).toBe(422);
    },
    30_000,
  );
});
