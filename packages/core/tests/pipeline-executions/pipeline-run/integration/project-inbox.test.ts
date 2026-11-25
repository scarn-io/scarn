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
import {
  conversations,
  nodeVisitQuestions,
  nodeVisits,
  pipelineGraphs,
  pipelineGraphVersions,
  pipelineRuns,
  tasks,
  workItemComments,
  workItems,
} from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const at = (minute: number) =>
  new Date(`2026-05-01T10:${String(minute).padStart(2, "0")}:00.000Z`);

const definitionJson = {
  nodes: {
    ask: { kind: "wait", for: "reply" },
    approve: {
      kind: "wait",
      for: "decision",
      title: "Ship it?",
      actions: [
        { key: "approve", label: "Approve" },
        { key: "reject", label: "Reject", body: "required" },
      ],
    },
  },
};

/** `GET /projects/:projectId/inbox/waits` and `/inbox/summary`. */
describe("project inbox", () => {
  let apiClient: ReturnType<typeof createScarnTreaty>;
  let owner: Awaited<ReturnType<typeof createTestUserAndSession>> | undefined;

  beforeAll(async () => {
    apiClient = createScarnTreaty(createApp(createAppContext()));
    owner = await createTestUserAndSession({
      email: `project-inbox-${crypto.randomUUID()}@example.com`,
    });
  });

  const requireOwner = () => {
    if (!owner) throw new Error("Expected setup to complete");
    return owner;
  };

  const createProject = async () => {
    const projectId = parseUuidV7(
      (
        await unwrapAsync(
          apiClient.api.projects.post(
            {
              name: `Project Inbox ${crypto.randomUUID()}`,
              description: "Project for the inbox",
              gitUrl: "https://github.com/example/test-project.git",
            },
            { headers: { ...requireOwner().authHeaders } },
          ),
        )
      ).id,
    );
    const member = await createTestUserAndSession({
      email: `project-inbox-member-${crypto.randomUUID()}@example.com`,
    });
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .members({ userId: member.userId })
        .role.put(
          { role: "read" },
          { headers: { ...requireOwner().authHeaders } },
        ),
    );
    return { projectId, member };
  };

  const seedRun = async (input: {
    projectId: UuidV7;
    createdByUserId: string | null;
    triggeredByUserId: string | null;
    status?: "active" | "waiting" | "succeeded";
  }) => {
    const db = getDb();
    const workItemId = await seedWorkItem(input.projectId);
    if (input.createdByUserId) {
      await db
        .update(workItems)
        .set({ createdByUserId: parseUuidV7(input.createdByUserId) })
        .where(eq(workItems.id, workItemId));
    }
    const pipelineGraphId = createUuidV7();
    const pipelineGraphVersionId = createUuidV7();
    await db.insert(pipelineGraphs).values({
      id: pipelineGraphId,
      projectId: input.projectId,
      key: `inbox_graph_${crypto.randomUUID()}`,
      name: "Review",
    });
    await db.insert(pipelineGraphVersions).values({
      id: pipelineGraphVersionId,
      pipelineGraphId,
      version: 1,
      definitionJson,
      schemaVersion: 1,
      contentHash: crypto.randomUUID(),
    });
    const runId = createUuidV7();
    await db.insert(pipelineRuns).values({
      id: runId,
      projectId: input.projectId,
      workItemId,
      pipelineGraphId,
      pipelineGraphVersionId,
      status: input.status ?? "waiting",
      triggeredByUserId: input.triggeredByUserId
        ? parseUuidV7(input.triggeredByUserId)
        : null,
      createdAt: at(0),
    });
    return { workItemId, runId };
  };

  const seedWaitVisit = async (
    runId: UuidV7,
    nodeId: string,
    minute: number,
  ) => {
    const id = createUuidV7();
    await getDb()
      .insert(nodeVisits)
      .values({
        id,
        pipelineRunId: runId,
        nodeId,
        nodeKind: "wait",
        transitionJson: { kind: "start", index: 0 },
        schemaVersion: 1,
        status: "waiting",
        inputJson: {},
        createdAt: at(minute),
      });
    return id;
  };

  const seedQuestion = async (input: {
    projectId: UuidV7;
    workItemId: UuidV7;
    runId: UuidV7;
    minute: number;
    status?: "open" | "answered";
  }) => {
    const visitId = await seedWaitVisit(input.runId, "ask", input.minute);
    const commentId = createUuidV7();
    await getDb().insert(workItemComments).values({
      id: commentId,
      projectId: input.projectId,
      workItemId: input.workItemId,
      authorKind: "agent",
      body: "Which database?",
    });
    const questionId = createUuidV7();
    await getDb()
      .insert(nodeVisitQuestions)
      .values({
        id: questionId,
        pipelineRunId: input.runId,
        visitId,
        commentId,
        status: input.status ?? "open",
        createdAt: at(input.minute),
      });
    return { visitId, commentId, questionId };
  };

  const seedTask = async (input: {
    projectId: UuidV7;
    workItemId: UuidV7;
    status: TaskStatus;
    /** On a work item with no creator or assignee, a waiting Task waits on its starter. */
    startedByUserId?: string;
  }) => {
    const conversationId =
      input.status === "waiting_for_person" ? createUuidV7() : null;
    if (conversationId) {
      await getDb().insert(conversations).values({
        id: conversationId,
        projectId: input.projectId,
        workItemId: input.workItemId,
        status: "waiting_for_person",
      });
    }
    await getDb()
      .insert(tasks)
      .values({
        id: createUuidV7(),
        projectId: input.projectId,
        workItemId: input.workItemId,
        kind: "agent",
        prompt: "Do the thing.",
        status: input.status,
        schemaVersion: 1,
        conversationId,
        startedByUserId: input.startedByUserId
          ? parseUuidV7(input.startedByUserId)
          : null,
      });
  };

  const seedProject = async () => {
    const { userId } = requireOwner();
    const { projectId, member } = await createProject();
    const mine = await seedRun({
      projectId,
      createdByUserId: null,
      triggeredByUserId: userId,
    });
    const decisionVisitId = await seedWaitVisit(mine.runId, "approve", 2);
    const question = await seedQuestion({
      projectId,
      workItemId: mine.workItemId,
      runId: mine.runId,
      minute: 3,
    });
    await seedQuestion({
      projectId,
      workItemId: mine.workItemId,
      runId: mine.runId,
      minute: 4,
      status: "answered",
    });

    const authored = await seedRun({
      projectId,
      createdByUserId: userId,
      triggeredByUserId: member.userId,
    });
    const authoredDecisionId = await seedWaitVisit(
      authored.runId,
      "approve",
      1,
    );

    const theirs = await seedRun({
      projectId,
      createdByUserId: member.userId,
      triggeredByUserId: member.userId,
    });
    const theirDecisionId = await seedWaitVisit(theirs.runId, "approve", 5);
    await seedQuestion({
      projectId,
      workItemId: theirs.workItemId,
      runId: theirs.runId,
      minute: 6,
    });

    const finished = await seedRun({
      projectId,
      createdByUserId: userId,
      triggeredByUserId: userId,
      status: "succeeded",
    });
    await seedWaitVisit(finished.runId, "approve", 7);

    return {
      projectId,
      member,
      mine,
      authored,
      decisionVisitId,
      authoredDecisionId,
      theirDecisionId,
      question,
    };
  };

  const inbox = (projectId: UuidV7) =>
    apiClient.api.projects({ projectId }).inbox;

  concurrentTest(
    "lists the open questions and decision waits on me, newest first",
    async () => {
      const { userId } = requireOwner();
      const seeded = await seedProject();

      const { waits } = await unwrapAsync(
        inbox(seeded.projectId).waits.get({
          headers: { ...requireOwner().authHeaders },
        }),
      );

      expect(waits.map((wait) => [wait.kind, wait.visitId])).toEqual([
        ["reply", seeded.question.visitId],
        ["decision", seeded.decisionVisitId],
        ["decision", seeded.authoredDecisionId],
      ]);
      const [reply, decision, authored] = waits;
      expect(reply).toMatchObject({
        kind: "reply",
        questionId: seeded.question.questionId,
        commentId: seeded.question.commentId,
        body: "Which database?",
        pipelineExecutionId: seeded.mine.runId,
        nodeId: "ask",
        pipelineName: "Review",
        workItem: { id: seeded.mine.workItemId },
        askedAt: at(3).toISOString(),
      });
      expect(decision).toMatchObject({
        kind: "decision",
        title: "Ship it?",
        actions: [
          { key: "approve", label: "Approve", body: "optional" },
          { key: "reject", label: "Reject", body: "required" },
        ],
      });
      expect(decision?.waitingOn.map((person) => person.userId)).toEqual([
        parseUuidV7(userId),
      ]);
      expect(authored?.waitingOn.map((person) => person.userId).sort()).toEqual(
        [parseUuidV7(userId), parseUuidV7(seeded.member.userId)].sort(),
      );
    },
  );

  concurrentTest("another member sees only the waits on them", async () => {
    const seeded = await seedProject();

    const { waits } = await unwrapAsync(
      inbox(seeded.projectId).waits.get({
        headers: { ...seeded.member.authHeaders },
      }),
    );

    expect(waits.map((wait) => wait.kind)).toEqual([
      "reply",
      "decision",
      "decision",
    ]);
    expect(waits.map((wait) => wait.visitId)).toContain(seeded.theirDecisionId);
    expect(waits.map((wait) => wait.visitId)).toContain(
      seeded.authoredDecisionId,
    );
  });

  concurrentTest(
    "summarises the badge from Task and pipeline waits and the work items with no Task",
    async () => {
      const { userId } = requireOwner();
      const seeded = await seedProject();
      const { projectId, member } = seeded;
      const workItemId = seeded.mine.workItemId;
      await seedTask({
        projectId,
        workItemId,
        status: "waiting_for_person",
        startedByUserId: userId,
      });
      await seedTask({
        projectId,
        workItemId,
        status: "waiting_for_person",
        startedByUserId: member.userId,
      });
      await seedTask({
        projectId,
        workItemId,
        status: "failed",
        startedByUserId: userId,
      });
      await seedTask({
        projectId,
        workItemId,
        status: "failed",
        startedByUserId: member.userId,
      });

      const summary = await unwrapAsync(
        inbox(projectId).summary.get({
          headers: { ...requireOwner().authHeaders },
        }),
      );

      // The authored and finished runs' work items: created by me, never given a Task.
      expect(summary).toEqual({
        waitingOnMe: 1,
        failedStartedByMe: 1,
        pipelineWaitsOnMe: 3,
        workItemsWaitingOnMe: 2,
        badgeCount: 7,
        waitingOnOthers: 1,
      });
    },
  );

  concurrentTest("rejects a caller outside the project", async () => {
    const { projectId } = await createProject();
    const outsider = await createTestUserAndSession({
      email: `project-inbox-outsider-${crypto.randomUUID()}@example.com`,
    });

    const waits = await inbox(projectId).waits.get({
      headers: { ...outsider.authHeaders },
    });
    const summary = await inbox(projectId).summary.get({
      headers: { ...outsider.authHeaders },
    });

    expect(waits.error?.status).toBe(403);
    expect(summary.error?.status).toBe(403);
  });
});
