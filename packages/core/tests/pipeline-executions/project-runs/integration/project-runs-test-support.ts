/**
 * Seeds pipeline runs, standalone Tasks and chats for the Runs list tests,
 * and reads the list as a member, a guest or anyone else.
 */
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type {
  ListProjectRunsQueryInput,
  ProjectRunsPageContract,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import {
  automations,
  conversationMessages,
  conversations,
  nodeVisitQuestions,
  nodeVisits,
  pipelineGraphVersions,
  pipelineGraphs,
  pipelineRuns,
  projects,
  stepDefinitions,
  taskRuns,
  tasks,
  workItemComments,
  workItems,
} from "@/lib/db/schema";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

/** Minute `minute` of a fixed day; rows are ordered by these. */
export const at = (minute: number) =>
  new Date(Date.UTC(2026, 4, 1, 10, 0) + minute * 60_000);

export const appContext = createAppContext();
export const apiClient = createScarnTreaty(createApp(appContext));

type User = Awaited<ReturnType<typeof createTestUserAndSession>>;

export type RunsProject = {
  projectId: UuidV7;
  owner: User;
  member: User;
};

const newUser = async (label: string) =>
  await createTestUserAndSession({
    email: `project-runs-${label}-${crypto.randomUUID()}@example.com`,
  });

/** A project with its owner and a member who may read executions. */
export const createRunsProject = async (): Promise<RunsProject> => {
  const owner = await newUser("owner");
  const projectId = parseUuidV7(
    (
      await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: `Project Runs ${crypto.randomUUID()}`,
            description: "Project for the Runs list",
            gitUrl: "https://github.com/example/test-project.git",
          },
          { headers: { ...owner.authHeaders } },
        ),
      )
    ).id,
  );
  const member = await newUser("member");
  await unwrapAsync(
    apiClient.api
      .projects({ projectId })
      .members({ userId: member.userId })
      .role.put({ role: "read" }, { headers: { ...owner.authHeaders } }),
  );
  return { projectId, owner, member };
};

/** Another signed-up user, a member of nothing. */
export const createOutsider = async (): Promise<User> =>
  await newUser("outsider");

export const markProjectPublic = async (projectId: UuidV7) => {
  await getDb()
    .update(projects)
    .set({ visibility: "public" })
    .where(eq(projects.id, projectId));
};

/** A signed-in user, or `null` for an anonymous visitor. */
export type Viewer = Pick<User, "authHeaders"> | null;

/** Raw query values, for queries the contract rejects. */
type RunsQuery = ListProjectRunsQueryInput | Record<string, string>;

const getRuns = (viewer: Viewer, projectId: UuidV7, query: RunsQuery) =>
  apiClient.api.projects({ projectId }).runs.get({
    query,
    headers: viewer ? { ...viewer.authHeaders } : {},
  });

/** The Runs list as `viewer` sees it, through `GET /projects/:projectId/runs`. */
export const listRuns = async (
  viewer: Viewer,
  projectId: UuidV7,
  query: RunsQuery = {},
): Promise<ProjectRunsPageContract> =>
  await unwrapAsync(getRuns(viewer, projectId, query));

/** The problem details the Runs list responds with when it refuses `query`. */
export const listRunsError = async (
  viewer: Viewer,
  projectId: UuidV7,
  query: RunsQuery = {},
): Promise<{ status: number; code?: string }> => {
  const { error } = await getRuns(viewer, projectId, query);
  if (!error) {
    throw new Error("Expected the Runs list to be refused");
  }
  return { ...(error.value as { code?: string }), status: error.status };
};

export const seedWorkItem = async (input: {
  projectId: UuidV7;
  title?: string;
  createdByUserId?: string | null;
  assigneeUserId?: string | null;
  parentWorkItemId?: UuidV7 | null;
}) => {
  const id = createUuidV7();
  const key = crypto.randomUUID().slice(0, 8);
  await getDb()
    .insert(workItems)
    .values({
      id,
      projectId: input.projectId,
      platform: "github",
      platformKey: `#${key}`,
      title: input.title ?? `Work item ${key}`,
      createdByUserId: input.createdByUserId
        ? parseUuidV7(input.createdByUserId)
        : null,
      assigneeUserId: input.assigneeUserId
        ? parseUuidV7(input.assigneeUserId)
        : null,
      parentWorkItemId: input.parentWorkItemId ?? null,
    });
  return { id, platformKey: `#${key}` };
};

export const seedAutomation = async (
  projectId: UuidV7,
  title: string | null = null,
) => {
  const id = createUuidV7();
  await getDb()
    .insert(automations)
    .values({
      id,
      projectId,
      key: `auto_${crypto.randomUUID().slice(0, 8)}`,
      title,
      scope: "project",
    });
  return id;
};

const pipelineDocument = {
  schemaVersion: 1,
  key: "runs_review",
  start: { to: "build" },
  nodes: {
    build: { kind: "step", step: "build" },
    lint: { kind: "step", step: "lint" },
    ask: { kind: "wait", for: "reply" },
    approve: {
      kind: "wait",
      for: "decision",
      actions: [{ key: "approve", label: "Approve" }],
    },
    done: { kind: "succeed" },
    rejected: { kind: "fail", error: "Rejected by review" },
  },
};

export const seedPipeline = async (projectId: UuidV7, name = "Review") => {
  const id = createUuidV7();
  const versionId = createUuidV7();
  await getDb()
    .insert(pipelineGraphs)
    .values({
      id,
      projectId,
      key: `runs_graph_${crypto.randomUUID()}`,
      name,
    });
  await getDb().insert(pipelineGraphVersions).values({
    id: versionId,
    pipelineGraphId: id,
    version: 1,
    definitionJson: pipelineDocument,
    schemaVersion: 1,
    contentHash: crypto.randomUUID(),
  });
  return { id, versionId, name };
};

type Pipeline = Awaited<ReturnType<typeof seedPipeline>>;

export const seedRun = async (input: {
  projectId: UuidV7;
  pipeline: Pipeline;
  workItemId: UuidV7;
  status: "active" | "waiting" | "succeeded" | "failed" | "cancelled";
  minute: number;
  endNodeId?: string | null;
  error?: { name: string; message: string } | null;
  triggeredByUserId?: string | null;
  automationId?: UuidV7 | null;
}) => {
  const id = createUuidV7();
  await getDb()
    .insert(pipelineRuns)
    .values({
      id,
      projectId: input.projectId,
      workItemId: input.workItemId,
      pipelineGraphId: input.pipeline.id,
      pipelineGraphVersionId: input.pipeline.versionId,
      status: input.status,
      endNodeId: input.endNodeId ?? null,
      errorJson: input.error ?? null,
      triggeredByUserId: input.triggeredByUserId
        ? parseUuidV7(input.triggeredByUserId)
        : null,
      startedByAutomationId: input.automationId ?? null,
      createdAt: at(input.minute),
      updatedAt: at(input.minute),
    });
  return id;
};

export const seedVisit = async (input: {
  runId: UuidV7;
  nodeId: string;
  nodeKind: "step" | "wait" | "succeed" | "fail";
  status: "active" | "waiting" | "succeeded" | "failed" | "cancelled";
  taskId?: UuidV7 | null;
  error?: { name: string; message: string } | null;
  minute?: number;
}) => {
  const id = createUuidV7();
  await getDb()
    .insert(nodeVisits)
    .values({
      id,
      pipelineRunId: input.runId,
      nodeId: input.nodeId,
      nodeKind: input.nodeKind,
      transitionJson: {},
      status: input.status,
      inputJson: {},
      taskId: input.taskId ?? null,
      errorJson: input.error ?? null,
      createdAt: at(input.minute ?? 0),
    });
  return id;
};

export const seedOpenQuestion = async (input: {
  projectId: UuidV7;
  workItemId: UuidV7;
  runId: UuidV7;
  visitId: UuidV7;
  body: string;
}) => {
  const commentId = createUuidV7();
  await getDb().insert(workItemComments).values({
    id: commentId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    authorKind: "agent",
    body: input.body,
  });
  await getDb()
    .insert(nodeVisitQuestions)
    .values({
      id: createUuidV7(),
      pipelineRunId: input.runId,
      visitId: input.visitId,
      commentId,
      status: "open",
      createdAt: at(0),
    });
};

export const seedStepDefinition = async (projectId: UuidV7, name: string) => {
  const id = createUuidV7();
  await getDb()
    .insert(stepDefinitions)
    .values({
      id,
      projectId,
      key: `step_${crypto.randomUUID().slice(0, 8)}`,
      name,
      version: 1,
      kind: "user_defined",
      prompt: "Do the step.",
      inputSchemaJson: {},
      status: "active",
    });
  return id;
};

export const seedTask = async (input: {
  projectId: UuidV7;
  workItemId: UuidV7 | null;
  status: TaskStatus;
  minute: number;
  prompt?: string;
  stepDefinitionId?: UuidV7 | null;
  startedByUserId?: string | null;
  automationId?: UuidV7 | null;
  conversationId?: UuidV7 | null;
  errorJson?: unknown;
}) => {
  const id = createUuidV7();
  await getDb()
    .insert(tasks)
    .values({
      id,
      projectId: input.projectId,
      workItemId: input.workItemId,
      stepDefinitionId: input.stepDefinitionId ?? null,
      kind: "agent",
      prompt: input.prompt ?? "Do the thing.",
      status: input.status,
      errorJson: input.errorJson ?? null,
      startedByUserId: input.startedByUserId
        ? parseUuidV7(input.startedByUserId)
        : null,
      startedByAutomationId: input.automationId ?? null,
      conversationId: input.conversationId ?? null,
      createdAt: at(input.minute),
      updatedAt: at(input.minute),
    });
  return id;
};

export const seedTaskRun = async (input: {
  taskId: UuidV7;
  projectId: UuidV7;
  workItemId: UuidV7 | null;
  status: "running" | "failed" | "succeeded";
  errorJson?: unknown;
  leaseExpiresAt?: Date | null;
}) => {
  const id = createUuidV7();
  await getDb()
    .insert(taskRuns)
    .values({
      id,
      taskId: input.taskId,
      number: 1,
      reason: "initial",
      projectId: input.projectId,
      workItemId: input.workItemId,
      status: input.status,
      errorJson: input.errorJson ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      startedAt: at(0),
    });
  return id;
};

/** A chat: a Task without a work item, with its conversation and messages. */
export const seedChat = async (input: {
  projectId: UuidV7;
  taskStatus: TaskStatus;
  minute: number;
  createdByUserId: string | null;
  closed?: boolean;
  question?: string;
  answer?: string;
}) => {
  const conversationId = createUuidV7();
  await getDb()
    .insert(conversations)
    .values({
      id: conversationId,
      projectId: input.projectId,
      status: input.closed ? "closed" : "agent_turn",
      createdAt: at(input.minute),
      updatedAt: at(input.minute),
    });
  const taskId = await seedTask({
    projectId: input.projectId,
    workItemId: null,
    status: input.taskStatus,
    minute: input.minute,
    startedByUserId: input.createdByUserId,
    conversationId,
  });
  const messages = [
    { kind: "person" as const, body: input.question ?? "How does it work?" },
    ...(input.answer ? [{ kind: "agent" as const, body: input.answer }] : []),
  ];
  for (const [index, message] of messages.entries()) {
    await getDb()
      .insert(conversationMessages)
      .values({
        id: createUuidV7(),
        conversationId,
        authorKind: message.kind,
        authorUserId:
          message.kind === "person" && input.createdByUserId
            ? parseUuidV7(input.createdByUserId)
            : null,
        body: message.body,
        createdAt: new Date(at(input.minute).getTime() + index),
      });
  }
  return { conversationId, taskId };
};
