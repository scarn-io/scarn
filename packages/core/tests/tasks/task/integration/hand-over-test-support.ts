import { beforeAll } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import type { ObjectStore } from "@/artifacts/object-store";
import type { TimeProvider } from "@/lib/time-provider";
import type { Grant } from "@/tasks/task/domain/grants";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { conversationMessages, tasks, workItems } from "@/lib/db/schema";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";

type Step = { id: UuidV7; version: number };
type StepKind = "findings" | "conversation" | "retrying" | "oneTurn";

/** Presigns deterministic URLs and records every deleted key. */
export const trackingObjectStore = () => {
  const deletedKeys: string[] = [];
  const store: ObjectStore = {
    putObject: () => Promise.resolve({ sizeBytes: 0 }),
    getObject: () => Promise.resolve(null),
    getObjectStream: () => Promise.resolve(null),
    getPresignedGetUrl: (key: string) =>
      Promise.resolve(`https://store.test/get/${key}`),
    getPresignedPutUrl: (key: string) =>
      Promise.resolve(`https://store.test/put/${key}`),
    deleteObject: (key: string) => {
      deletedKeys.push(key);
      return Promise.resolve();
    },
    deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
  };
  return { store, deletedKeys };
};

/**
 * A project with agent step definitions (one with a result schema, a
 * conversation step with none, a conversation step that retries every
 * error once, and a conversation step with one turn), and the calls to start a standalone Task on a work item, run
 * it and hand it over. Call inside a `describe`.
 */
export const createHandOverHarness = (
  options: {
    objectStore?: ObjectStore | null;
    timeProvider?: TimeProvider;
    /** The work item grants every step definition gives its Tasks. */
    grants?: Grant[];
    /** Whether every step definition's Tasks may ask for more grants. */
    grantRequests?: boolean;
  } = {},
) => {
  const { grants = [], grantRequests = false, ...overrides } = options;
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-01-01T12:00:00.000Z")),
    ...overrides,
  });
  const apiClient = createScarnTreaty(createApp(appContext));
  let project: ProjectContract | undefined;
  let headers: { authorization: string } | undefined;
  let ownerId: UuidV7 | undefined;
  let steps: Record<StepKind, Step> | undefined;

  const createStep = async (
    projectId: string,
    authHeaders: { authorization: string },
    resultSchemaJson: { type: "object" } | null,
    retry: { on: string[]; maxAttempts: number }[] = [],
    maxTurns: number | null = null,
  ): Promise<Step> => {
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(projectId),
          key: `hand_over_${crypto.randomUUID()}`,
          name: "hand over",
          description: "Step for hand-over tests",
          prompt: "Ask a question.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson,
          retry,
          maxTurns,
          status: "active",
          repo: { mode: "readOnly" },
          grants,
          grantRequests,
        },
        { headers: { ...authHeaders } },
      ),
    );
    return { id: parseUuidV7(created.id), version: created.version };
  };

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `hand-over-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    ownerId = parseUuidV7(owner.userId);
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Hand Over Project",
          description: "Project for hand-over tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    steps = {
      findings: await createStep(project.id, owner.authHeaders, {
        type: "object",
      }),
      conversation: await createStep(project.id, owner.authHeaders, null),
      retrying: await createStep(project.id, owner.authHeaders, null, [
        { on: ["Scarn.All"], maxAttempts: 1 },
      ]),
      oneTurn: await createStep(project.id, owner.authHeaders, null, [], 1),
    };
  });

  const requireSetup = () => {
    if (!project || !headers || !ownerId || !steps) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId: parseUuidV7(project.id),
      headers: { ...headers },
      ownerId,
      steps,
    };
  };

  const seedItem = async (
    people: { createdByUserId?: UuidV7; assigneeUserId?: UuidV7 } = {},
  ) => {
    const id = createUuidV7();
    await getDb()
      .insert(workItems)
      .values({
        id,
        projectId: requireSetup().projectId,
        platform: "scarn",
        platformKey: `manual-${id}`,
        title: `Item ${id}`,
        description: "Original",
        ...people,
      });
    return id;
  };

  const claim = async (workItemId: UuidV7, taskRunId: string) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `hand-over-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (each) => each.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the run");
    }
    return claimToken;
  };

  const yieldRun = async (
    workItemId: UuidV7,
    taskRunId: string,
    yielded: {
      message: string;
      workBranch?: string;
      workItemChanges?: WorkItemChange[];
      grantRequest?: { reason: string; grants: Grant[] };
    },
  ) => {
    const claimToken = await claim(workItemId, taskRunId);
    return await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).yields.post(
        { claimToken, ...yielded },
        { headers: requireSetup().headers },
      ),
    );
  };

  /** Claims the run and hands it over with an uploaded session; returns the session's key. */
  const yieldWithSession = async (
    workItemId: UuidV7,
    taskRunId: string,
    message: string,
  ) => {
    const claimToken = await claim(workItemId, taskRunId);
    const routes = apiClient.api["task-runs"]({ taskRunId });
    const { headers } = requireSetup();
    const upload = await unwrapAsync(
      routes["session-upload-url"].post(
        { claimToken, sizeBytes: 128 },
        { headers },
      ),
    );
    await unwrapAsync(
      routes.yields.post(
        { claimToken, message, sessionObjectKey: upload.objectKey },
        { headers },
      ),
    );
    return upload.objectKey;
  };

  const completeRun = async (
    taskRunId: string,
    claimToken: string,
    outcome: (
      | { status: "succeeded"; resultJson: AnyJsonValue }
      | { status: "failed"; errorJson: AnyJsonValue }
    ) & { workItemChanges?: WorkItemChange[] },
  ) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
        { claimToken, resultJson: null, errorJson: null, ...outcome },
        { headers: requireSetup().headers },
      ),
    );

  const workerContext = async (taskRunId: string, claimToken: string) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId })["worker-context"].post(
        { claimToken },
        { headers: requireSetup().headers },
      ),
    );

  const startTask = async (workItemId: UuidV7, kind: StepKind = "findings") => {
    const { projectId, headers, steps } = requireSetup();
    const step = steps[kind];
    const started = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: step.id,
          stepDefinitionVersion: step.version,
          inputJson: null,
        },
        { headers },
      ),
    );
    const taskRunId = started.run?.id;
    if (!taskRunId) {
      throw new Error("Expected the Task to start with a run");
    }
    return { taskId: parseUuidV7(started.task.id), taskRunId };
  };

  const loadTask = async (taskId: UuidV7) =>
    (await getDb().select().from(tasks).where(eq(tasks.id, taskId)))[0];

  const messagesOf = async (conversationId: string) =>
    await getDb()
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(asc(conversationMessages.id));

  /** Starts a standalone Task whose first run hands over; returns its conversation. */
  const handedOver = async (
    kind: StepKind = "findings",
    message = "v1 or v2?",
  ) => {
    const workItemId = await seedItem();
    const { taskId, taskRunId } = await startTask(workItemId, kind);
    await yieldRun(workItemId, taskRunId, {
      message,
      workBranch: "scarn/hand-over-1",
    });
    const conversationId = (await loadTask(taskId))?.conversationId;
    if (!conversationId) {
      throw new Error("Expected the Task's conversation");
    }
    return {
      workItemId,
      taskId,
      taskRunId,
      conversationId: parseUuidV7(conversationId),
    };
  };

  const conversationRoutes = (conversationId: UuidV7) =>
    apiClient.api.conversations({ conversationId });

  /** The Task as `GET /tasks/:taskId` shows it to the project owner. */
  const taskView = async (taskId: UuidV7) =>
    await unwrapAsync(
      apiClient.api.tasks({ taskId }).get({ headers: requireSetup().headers }),
    );

  return {
    taskView,
    appContext,
    apiClient,
    requireSetup,
    seedItem,
    claim,
    yieldRun,
    yieldWithSession,
    completeRun,
    workerContext,
    startTask,
    loadTask,
    messagesOf,
    handedOver,
    conversationRoutes,
  };
};
