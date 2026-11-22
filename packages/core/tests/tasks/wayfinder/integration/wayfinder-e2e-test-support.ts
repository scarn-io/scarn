import { afterAll, beforeAll } from "bun:test";
import { rmSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import type { PushFromDirectoryResult } from "@scarn/sdk/push";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { stepDefinitions, taskRuns, tasks, workItems } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { trackingObjectStore } from "tests/tasks/task/integration/hand-over-test-support";
import {
  buildWayfinderBuilderDirectory,
  pushToApp,
} from "./wayfinder-e2e-template";

const WAYFINDER_KEY = "wayfinder";

/** An automation activity line for the Wayfinder automation. */
export const line = (event: string, rule: number, outcome: string) =>
  `Automation wayfinder · ${event} · rule ${String(rule)}: ${outcome}`;

/** A `close` change, `completed`, with a resolution. */
export const closeOwn = (
  workItemId: UuidV7,
  resolution: string,
): WorkItemChange => ({
  kind: "close",
  workItemId,
  reason: "completed",
  resolution,
});

export const childIn = (map: { children: { id: string }[] }, id: UuidV7) =>
  map.children.find((each) => each.id === String(id));

/**
 * A project set up the way a user sets up Wayfinder (the template rendered,
 * built and pushed), plus what a person does on the map (attach Wayfinder,
 * edit, close, block) and the calls a worker makes to claim, create
 * children, hand over and complete runs. Call inside a `describe`.
 */
export const createWayfinderHarness = () => {
  const objectStore = trackingObjectStore();
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(new Date("2026-01-01T12:00:00.000Z")),
    objectStore: objectStore.store,
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let headers: { authorization: string } | undefined;
  let builderDir: string | undefined;
  let pushed: PushFromDirectoryResult | undefined;

  afterAll(() => {
    if (builderDir !== undefined) {
      rmSync(builderDir, { recursive: true, force: true });
    }
  });

  beforeAll(async () => {
    builderDir = await buildWayfinderBuilderDirectory();
    const owner = await createTestUserAndSession({
      email: `wayfinder-e2e-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    const created = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Wayfinder Project",
          description: "Project for the wayfinder end-to-end test",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    project = created;
    pushed = await pushToApp(app, builderDir, created.id, owner.sessionToken);
  }, 30_000);

  const requireSetup = () => {
    if (!project || !headers) {
      throw new Error("Expected setup to complete");
    }
    return { projectId: parseUuidV7(project.id), headers: { ...headers } };
  };

  const workItemRoutes = (workItemId: UuidV7) =>
    apiClient.api["work-items"]({ workItemId });

  const createRoot = async (title: string) => {
    const { projectId, headers } = requireSetup();
    const created = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${crypto.randomUUID()}`,
          url: null,
          title,
          description: "Find the way.",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers },
      ),
    );
    return parseUuidV7(created.id);
  };

  /** What pushing the rendered template published. */
  const pushResult = () => {
    if (!pushed) {
      throw new Error("Expected setup to complete");
    }
    return pushed;
  };

  /** Attaches the Wayfinder automation to the work item, as a person does. */
  const attachWayfinder = async (workItemId: UuidV7) =>
    await unwrapAsync(
      workItemRoutes(workItemId)
        .automations({ key: WAYFINDER_KEY })
        .post(undefined, { headers: requireSetup().headers }),
    );

  /** A person's description edit, naming the version they loaded. */
  const editDescription = async (
    workItemId: UuidV7,
    description: string,
    descriptionVersion: number,
  ) =>
    await unwrapAsync(
      workItemRoutes(workItemId).patch(
        { description, descriptionVersion },
        { headers: requireSetup().headers },
      ),
    );

  /** A person closing the work item by hand, `completed`, with a resolution. */
  const closeByHand = async (workItemId: UuidV7, resolution: string) =>
    await unwrapAsync(
      workItemRoutes(workItemId).state.put(
        { state: "closed", reason: "completed", resolution },
        { headers: requireSetup().headers },
      ),
    );

  const reopen = async (workItemId: UuidV7) =>
    await unwrapAsync(
      workItemRoutes(workItemId).state.put(
        { state: "open" },
        { headers: requireSetup().headers },
      ),
    );

  /** A person blocking `blocked` on `blocking`; returns the block's id. */
  const block = async (blocked: UuidV7, blocking: UuidV7) =>
    parseUuidV7(
      (
        await unwrapAsync(
          apiClient.api["work-item-blocks"].post(
            {
              blockedWorkItemId: parseWorkItemId(blocked),
              blockingWorkItemId: parseWorkItemId(blocking),
            },
            { headers: requireSetup().headers },
          ),
        )
      ).id,
    );

  const unblock = async (blockId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["work-item-blocks"]({ blockId }).delete(undefined, {
        headers: requireSetup().headers,
      }),
    );

  /** The work item's activity messages, oldest first. */
  const activityOf = async (workItemId: UuidV7) =>
    (
      await unwrapAsync(
        workItemRoutes(workItemId).activity.get({
          headers: requireSetup().headers,
        }),
      )
    ).map((entry) => entry.message);

  /** Each child work item's status, as the children section groups it. */
  const childStatusesOf = async (workItemId: UuidV7) =>
    Object.fromEntries(
      (
        await unwrapAsync(
          workItemRoutes(workItemId).children.get({
            headers: requireSetup().headers,
          }),
        )
      ).map((child) => [String(child.id), child.status]),
    );

  const loadItem = async (id: UuidV7) =>
    (await getDb().select().from(workItems).where(eq(workItems.id, id)))[0];

  const loadTask = async (id: UuidV7) =>
    (await getDb().select().from(tasks).where(eq(tasks.id, id)))[0];

  const runsOf = async (taskId: UuidV7) =>
    (
      await getDb().select().from(taskRuns).where(eq(taskRuns.taskId, taskId))
    ).sort((a, b) => a.number - b.number);

  /** The Tasks on the item, oldest first, with their step's key. */
  const tasksOn = async (workItemId: UuidV7) =>
    (
      await getDb()
        .select({ task: tasks, stepKey: stepDefinitions.key })
        .from(tasks)
        .leftJoin(
          stepDefinitions,
          eq(stepDefinitions.id, tasks.stepDefinitionId),
        )
        .where(eq(tasks.workItemId, workItemId))
        .orderBy(asc(tasks.id))
    ).map(({ task, stepKey }) => ({ ...task, stepKey }));

  /** The only Task on the item. */
  const taskOn = async (workItemId: UuidV7) => {
    const [task, ...others] = await tasksOn(workItemId);
    if (!task || others.length > 0) {
      throw new Error(`Expected one Task on ${workItemId}`);
    }
    return task;
  };

  /** Claims the Task's latest run, which must be queued with `reason`. */
  const claimLatest = async (taskId: UuidV7, reason: string) => {
    const task = await loadTask(taskId);
    const run = (await runsOf(taskId)).at(-1);
    if (!task || run?.status !== "queued" || run.reason !== reason) {
      throw new Error(`Expected a queued ${reason} run on Task ${taskId}`);
    }
    if (task.workItemId === null) {
      throw new Error(`Expected Task ${taskId} to have a work item`);
    }
    const workItemId = task.workItemId;
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId: parseUuidV7(workItemId),
          workerId: `wayfinder-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (each) => each.task.id === run.id,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the run");
    }
    const routes = apiClient.api["task-runs"]({ taskRunId: run.id });
    return { taskRunId: run.id, claimToken, routes };
  };

  type Claimed = Awaited<ReturnType<typeof claimLatest>>;

  const workerContext = async ({ routes, claimToken }: Claimed) =>
    await unwrapAsync(
      routes["worker-context"].post(
        { claimToken },
        { headers: requireSetup().headers },
      ),
    );

  /** Reads a work item live, as the run's `scarn-get-work-item` tool does. */
  const readLive = async (
    { routes, claimToken }: Claimed,
    workItemId: UuidV7,
  ) =>
    await unwrapAsync(
      routes["work-item-reads"].post({
        claimToken,
        workItemId: parseWorkItemId(workItemId),
      }),
    );

  /**
   * Creates a labelled child of the map as the run's `scarn-create-work-item`
   * tool does: committed at once, whatever the run does afterwards.
   */
  const createChild = async (
    { routes, claimToken }: Claimed,
    workItemId: UuidV7,
    label: string,
    blockedBy: UuidV7[] = [],
  ) =>
    await unwrapAsync(
      routes["work-item-creates"].post({
        claimToken,
        workItemId: parseWorkItemId(workItemId),
        title: `${label} ${workItemId}`,
        description: `Answer one question (${label}).`,
        labels: [label],
        ...(blockedBy.length > 0
          ? { blockedBy: blockedBy.map(parseWorkItemId) }
          : {}),
      }),
    );

  /** Hands the run over to a person with a saved session. */
  const handOver = async (claimed: Claimed, message: string) => {
    const { headers } = requireSetup();
    const { objectKey } = await unwrapAsync(
      claimed.routes["session-upload-url"].post(
        { claimToken: claimed.claimToken, sizeBytes: 128 },
        { headers },
      ),
    );
    await unwrapAsync(
      claimed.routes.yields.post(
        {
          claimToken: claimed.claimToken,
          message,
          sessionObjectKey: objectKey,
        },
        { headers },
      ),
    );
  };

  /** Reports the run succeeded with its work item changes; returns the run. */
  const succeed = async (
    { routes, claimToken }: Claimed,
    resultJson: AnyJsonValue,
    workItemChanges: WorkItemChange[] = [],
  ) =>
    await unwrapAsync(
      routes.completions.post(
        {
          claimToken,
          status: "succeeded",
          resultJson,
          errorJson: null,
          workItemChanges,
        },
        { headers: requireSetup().headers },
      ),
    );

  const fail = async (
    { routes, claimToken }: Claimed,
    errorJson: AnyJsonValue,
  ) =>
    await unwrapAsync(
      routes.completions.post(
        { claimToken, status: "failed", resultJson: null, errorJson },
        { headers: requireSetup().headers },
      ),
    );

  const reply = async (conversationId: string, body: string) =>
    await unwrapAsync(
      apiClient.api
        .conversations({ conversationId: parseUuidV7(conversationId) })
        .messages.post({ body }, { headers: requireSetup().headers }),
    );

  return {
    pushResult,
    createRoot,
    attachWayfinder,
    editDescription,
    closeByHand,
    reopen,
    block,
    unblock,
    activityOf,
    childStatusesOf,
    loadItem,
    loadTask,
    runsOf,
    tasksOn,
    taskOn,
    claimLatest,
    workerContext,
    readLive,
    createChild,
    handOver,
    succeed,
    fail,
    reply,
  };
};
