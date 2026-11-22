import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { conversations, tasks, workItems } from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import {
  createListingProject,
  createScoringPipeline,
  recordExecutionResult,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * The assignee, Agent, latest-run status and platform filters of
 * `GET /projects/:projectId/work-items`, plus each item's `assignee` and
 * `taskStatusCounts`. Every case gets its own project, so `total` and the
 * unfiltered list only ever see that case's items.
 */
describe("project work items agent and assignee filters", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-05-01T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let other: Awaited<ReturnType<typeof createTestUserAndSession>> | undefined;

  beforeAll(async () => {
    other = await createTestUserAndSession({
      email: `listing-other-${crypto.randomUUID()}@example.com`,
    });
  });

  const otherUserId = (): UuidV7 => {
    if (!other) throw new Error("Expected setup to complete");
    return parseUuidV7(other.userId);
  };

  const list = async (
    project: ListingProject,
    query: Record<string, string> = {},
  ) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        ["work-items"].get({
          query: { page: 1, pageSize: 25, ...query },
          headers: { ...project.authHeaders },
        }),
    );

  const titles = (page: Awaited<ReturnType<typeof list>>) =>
    page.items.map((item) => item.title).sort();

  const viewerId = async (project: ListingProject): Promise<UuidV7> => {
    const members = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        .members.get({ headers: { ...project.authHeaders } }),
    );
    const [owner] = members;
    if (!owner) throw new Error("Expected the project owner to be a member");
    return parseUuidV7(owner.userId);
  };

  const seedTitled = async (project: ListingProject, names: string[]) => {
    const created = await seedWorkItems(
      apiClient,
      project,
      names.map((title) => ({ title })),
    );
    return new Map(
      created.map((item) => [item.title, parseUuidV7(item.id)] as const),
    );
  };

  const idOf = (ids: Map<string, UuidV7>, title: string): UuidV7 => {
    const id = ids.get(title);
    if (!id) throw new Error(`Expected a seeded item titled ${title}`);
    return id;
  };

  const seedTask = async (input: {
    project: ListingProject;
    workItemId: UuidV7;
    status: TaskStatus;
    /** Opens the Task's conversation and makes this person the item's only waited-on one. */
    waitingOn?: UuidV7;
  }) => {
    const conversationId = input.waitingOn ? createUuidV7() : null;
    if (input.waitingOn && conversationId) {
      await getDb()
        .update(workItems)
        .set({ assigneeUserId: input.waitingOn, createdByUserId: null })
        .where(eq(workItems.id, input.workItemId));
      await getDb().insert(conversations).values({
        id: conversationId,
        projectId: input.project.projectId,
        workItemId: input.workItemId,
        status: "waiting_for_person",
      });
    }
    await getDb().insert(tasks).values({
      id: createUuidV7(),
      projectId: input.project.projectId,
      workItemId: input.workItemId,
      kind: "agent",
      prompt: "Do the thing.",
      status: input.status,
      conversationId,
    });
  };

  const assign = async (workItemId: UuidV7, userId: UuidV7) => {
    await getDb()
      .update(workItems)
      .set({ assigneeUserId: userId })
      .where(eq(workItems.id, workItemId));
  };

  const seedAgentProject = async () => {
    const project = await createListingProject(apiClient, "agent-filter");
    const me = await viewerId(project);
    const ids = await seedTitled(project, [
      "mine-waiting",
      "others-waiting",
      "running",
      "queued",
      "blocked",
      "failed",
      "finished",
      "idle",
    ]);
    const on = (title: string) => idOf(ids, title);
    await seedTask({
      project,
      workItemId: on("mine-waiting"),
      status: "waiting_for_person",
      waitingOn: me,
    });
    await seedTask({
      project,
      workItemId: on("others-waiting"),
      status: "waiting_for_person",
      waitingOn: otherUserId(),
    });
    await seedTask({ project, workItemId: on("running"), status: "running" });
    await seedTask({ project, workItemId: on("running"), status: "running" });
    await seedTask({ project, workItemId: on("queued"), status: "queued" });
    await seedTask({
      project,
      workItemId: on("blocked"),
      status: "waiting_for_work",
    });
    await seedTask({ project, workItemId: on("failed"), status: "failed" });
    await seedTask({
      project,
      workItemId: on("finished"),
      status: "succeeded",
    });
    return project;
  };

  concurrentTest(
    "each agent filter keeps only items with a matching Task",
    async () => {
      const project = await seedAgentProject();

      expect(titles(await list(project, { agent: "waiting_on_me" }))).toEqual([
        "mine-waiting",
      ]);
      expect(titles(await list(project, { agent: "running" }))).toEqual([
        "running",
      ]);
      expect(titles(await list(project, { agent: "queued" }))).toEqual([
        "queued",
      ]);
      expect(
        titles(await list(project, { agent: "waiting_on_blockers" })),
      ).toEqual(["blocked"]);
      const failed = await list(project, { agent: "failed" });
      expect(titles(failed)).toEqual(["failed"]);
      expect(failed.pagination.total).toBe(1);
      expect((await list(project, { agent: "bogus" })).items).toHaveLength(8);
    },
  );

  concurrentTest(
    "waiting_on_me is about the viewer, not whoever the Task waits on",
    async () => {
      const project = await seedAgentProject();
      if (!other) throw new Error("Expected setup to complete");
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.projectId })
          .members({ userId: other.userId })
          .role.put({ role: "read" }, { headers: { ...project.authHeaders } }),
      );

      const page = await list(
        { ...project, authHeaders: other.authHeaders },
        { agent: "waiting_on_me" },
      );

      expect(titles(page)).toEqual(["others-waiting"]);
      expect(page.items[0]?.taskStatusCounts.waitingOnYou).toBe(1);
    },
  );

  concurrentTest(
    "taskStatusCounts counts live and attention Tasks per item",
    async () => {
      const project = await seedAgentProject();
      const page = await list(project);
      const counts = new Map(
        page.items.map((item) => [item.title, item.taskStatusCounts]),
      );
      const zero = {
        running: 0,
        queued: 0,
        waitingForPerson: 0,
        waitingOnYou: 0,
        waitingForWork: 0,
        failed: 0,
      };

      expect(counts.get("mine-waiting")).toEqual({
        ...zero,
        waitingForPerson: 1,
        waitingOnYou: 1,
      });
      expect(counts.get("others-waiting")).toEqual({
        ...zero,
        waitingForPerson: 1,
      });
      expect(counts.get("running")).toEqual({ ...zero, running: 2 });
      expect(counts.get("queued")).toEqual({ ...zero, queued: 1 });
      expect(counts.get("blocked")).toEqual({ ...zero, waitingForWork: 1 });
      expect(counts.get("failed")).toEqual({ ...zero, failed: 1 });
      expect(counts.get("finished")).toEqual(zero);
      expect(counts.get("idle")).toEqual(zero);
      expect(page.pagination.total).toBe(8);
    },
  );

  concurrentTest(
    "filters by assignee me, none, or a user id, and lists the assignee",
    async () => {
      const project = await createListingProject(apiClient, "assignee-filter");
      const me = await viewerId(project);
      const ids = await seedTitled(project, ["mine", "theirs", "nobody's"]);
      await assign(idOf(ids, "mine"), me);
      await assign(idOf(ids, "theirs"), otherUserId());

      expect(titles(await list(project, { assignee: "me" }))).toEqual(["mine"]);
      expect(titles(await list(project, { assignee: "none" }))).toEqual([
        "nobody's",
      ]);
      expect(titles(await list(project, { assignee: otherUserId() }))).toEqual([
        "theirs",
      ]);
      expect(
        (await list(project, { assignee: "not-a-user" })).items,
      ).toHaveLength(3);

      const members = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.projectId })
          .members.get({ headers: { ...project.authHeaders } }),
      );
      const page = await list(project);
      const byTitle = new Map(page.items.map((item) => [item.title, item]));
      const myMember = members.find((member) => member.userId === me);
      expect(byTitle.get("mine")?.assignee).toEqual(
        myMember
          ? {
              userId: myMember.userId,
              username: myMember.username,
              image: myMember.image,
            }
          : null,
      );
      expect(byTitle.get("theirs")?.assignee?.userId).toBe(otherUserId());
      expect(byTitle.get("nobody's")?.assignee).toBeNull();
    },
  );

  concurrentTest("filters by platform", async () => {
    const project = await createListingProject(apiClient, "platform-filter");
    await seedWorkItems(apiClient, project, [
      { title: "on github", platform: "github" },
      { title: "on jira", platform: "jira" },
    ]);

    expect(titles(await list(project, { platform: "jira" }))).toEqual([
      "on jira",
    ]);
    expect(titles(await list(project, { platform: "github" }))).toEqual([
      "on github",
    ]);
    expect((await list(project, { platform: "nope" })).items).toHaveLength(2);
  });

  concurrentTest("filters by the latest pipeline run's status", async () => {
    const project = await createListingProject(apiClient, "status-filter");
    const pipelineId = await createScoringPipeline(apiClient, project);
    const ids = await seedTitled(project, ["recovered", "broke", "never"]);
    const run = (title: string, status: "succeeded" | "failed") =>
      recordExecutionResult(
        apiClient,
        project,
        pipelineId,
        idOf(ids, title),
        status,
      );
    await run("recovered", "failed");
    await run("recovered", "succeeded");
    await run("broke", "failed");

    expect(titles(await list(project, { status: "failed" }))).toEqual([
      "broke",
    ]);
    expect(titles(await list(project, { status: "succeeded" }))).toEqual([
      "recovered",
    ]);
    expect((await list(project, { status: "queued" })).items).toHaveLength(3);
  });
});
