import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  createRunsProject,
  listRuns,
  seedChat,
  type RunsProject,
} from "./project-runs-test-support";
import { seedTaskAndChatCases, byId } from "./project-runs-cases";

/** Standalone Task rows of the Runs list, with or without a work item. */
describe("project runs: Tasks", () => {
  let project: RunsProject;
  let ids: Awaited<ReturnType<typeof seedTaskAndChatCases>>["ids"];
  let automationId: string;

  beforeAll(async () => {
    project = await createRunsProject();
    ({ ids, automationId } = await seedTaskAndChatCases(project));
  });

  concurrentTest("derives Task rows", async () => {
    const rows = byId(await listRuns(project.owner, project.projectId));
    const row = (key: keyof typeof ids) => rows.get(ids[key]);
    expect(row("prompt")).toMatchObject({
      type: "task",
      title: "Fix the flaky test",
      whatRan: { kind: "task", name: "Task" },
      status: "running",
      href: `runs/tasks/${ids.prompt}`,
      startedBy: { kind: "user", userId: project.owner.userId },
      workItem: { title: "Owner's item", parent: null },
    });
    expect(row("step")).toMatchObject({
      type: "step",
      title: "Owner's item",
      whatRan: { kind: "step", name: "Triage" },
      status: "done",
      startedBy: {
        kind: "automation",
        automationId,
        title: "Nightly triage",
      },
    });
    expect(row("waitingOnOwner")).toMatchObject({
      status: "needs-you",
      waitingOnYou: true,
    });
    expect(row("waitingOnMember")).toMatchObject({
      status: "waiting",
      waitingOnYou: false,
    });
    expect(row("waitingOnMember")?.waitingOn.map((p) => p.userId)).toEqual([
      project.member.userId as never,
    ]);
    expect(row("failed")).toMatchObject({
      status: "failed",
      statusLine: "tsc exited with 2",
      outcome: "Build.Broken",
    });
    expect(row("lapsed")).toMatchObject({ status: "failed" });
    expect(row("queued")).toMatchObject({ status: "queued" });
  });

  concurrentTest(
    "derives rows for Tasks without a work item from their conversation",
    async () => {
      const rows = byId(await listRuns(project.owner, project.projectId));
      const row = (key: keyof typeof ids) => rows.get(ids[key]);
      expect(row("chatWaiting")).toMatchObject({
        type: "task",
        id: ids.chatWaiting,
        title: "How do builds work?",
        whatRan: { kind: "task", name: "Task" },
        workItem: null,
        status: "needs-you",
        statusLine: "They run in CI. Anything else?",
        waitingOnYou: true,
        href: `runs/tasks/${ids.chatWaiting}`,
      });
      expect(row("chatEnded")).toMatchObject({
        status: "done",
        waitingOn: [],
      });
      expect(row("chatFailed")).toMatchObject({ status: "failed" });
      expect(row("chatRunning")).toMatchObject({
        status: "running",
        startedBy: { kind: "user", userId: project.member.userId },
      });
    },
  );

  concurrentTest(
    "a cancelled Task without a work item is cancelled",
    async () => {
      const { taskId } = await seedChat({
        projectId: project.projectId,
        taskStatus: "cancelled",
        minute: 12,
        createdByUserId: project.owner.userId,
        closed: true,
        question: "Cancelled ocelot question",
      });
      const { runs } = await listRuns(project.owner, project.projectId, {
        q: "ocelot",
      });
      expect(runs).toMatchObject([
        { id: taskId, type: "task", workItem: null, status: "cancelled" },
      ]);
    },
  );

  concurrentTest(
    "a Task without a work item waits on its starter only",
    async () => {
      const rows = byId(await listRuns(project.member, project.projectId));
      expect(rows.get(ids.chatWaiting)).toMatchObject({
        status: "waiting",
        waitingOnYou: false,
      });
      expect(rows.get(ids.waitingOnMember)).toMatchObject({
        status: "needs-you",
      });
    },
  );
});
