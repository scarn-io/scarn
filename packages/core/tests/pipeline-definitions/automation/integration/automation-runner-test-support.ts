import { and, eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { getDb } from "@/lib/db";
import { automations } from "@/lib/db/schema";
import type { AnyJsonObject } from "@/common/contracts/json";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@/common/contracts/uuid-v7";
import { createAppContext } from "@/lib/di";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  createPipelineFromDocument,
  singleStepPipelineDocument,
} from "../../pipeline-test-support";
import { allGrants } from "tests/tasks/task/grants-test-support";
import type { Grant } from "@/tasks/task/domain/grants";

const CHILD_LABELS = ["kind:research"];

type StepOptions = {
  inputSchemaJson?: AnyJsonObject;
  concurrency?: { max: number; waiting: number };
  children?: boolean;
  grants?: Grant[];
};

export type Step = { id: UuidV7; version: number; key: string };

/**
 * A project for automation runner tests, and the API calls they make: steps
 * named after their keys (so a Task's name is its step key), publishing,
 * attaching and enabling automations, driving work items, and reading the
 * Tasks and activity they end up with.
 */
export const createRunnerHarness = async (label: string) => {
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-11-02T09:00:00.000Z")),
      }),
    ),
  );
  const owner = await createTestUserAndSession({
    email: `automation-runner-${label}-${crypto.randomUUID()}@example.com`,
  });
  const headers = { ...owner.authHeaders };
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: `Automation runner ${label}`,
        description: "Project for automation runner tests",
        gitUrl: "https://github.com/example/test-project.git",
      },
      { headers },
    ),
  );
  const projectId = parseUuidV7(project.id);

  const createStep = async (
    name: string,
    options: StepOptions = {},
  ): Promise<Step> => {
    const key = `${name}_${crypto.randomUUID().slice(0, 8)}`;
    const created = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key,
          name: key,
          description: "Step for automation runner tests",
          prompt: "Do the work.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: options.inputSchemaJson ?? { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants: [
            ...(options.children
              ? [
                  ...allGrants("self", CHILD_LABELS),
                  ...allGrants("children", CHILD_LABELS),
                ]
              : []),
            ...(options.grants ?? []),
          ],
          ...(options.concurrency ? { concurrency: options.concurrency } : {}),
        },
        { headers },
      ),
    );
    return { id: parseUuidV7(created.id), version: created.version, key };
  };

  const wayfinder = await createStep("wayfinder", { children: true });

  const publish = async (document: AnyJsonObject) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .automations({ key: document["key"] as string })
        .put({ document }, { headers }),
    );

  const attach = async (workItemId: string, key: string) =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId })
        .automations({ key })
        .post(undefined, { headers }),
    );

  const enable = async (key: string) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .automations({ key })
        .enable.post(undefined, { headers }),
    );

  const createItem = async (title = "Item") => {
    const created = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${createUuidV7()}`,
          url: null,
          title,
          description: "Do it.",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers },
      ),
    );
    return parseUuidV7(created.id);
  };

  const syncItem = async (platformKey: string, labels: string[]) => {
    const [saved] = await unwrapAsync(
      apiClient.api["work-items"].batch.put(
        [
          {
            projectId,
            platform: "jira",
            platformId: `jira-${platformKey}`,
            platformKey,
            url: `https://acme.atlassian.net/browse/${platformKey}`,
            title: `Item ${platformKey}`,
            description: "Synced",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
            labels,
          },
        ],
        { headers },
      ),
    );
    if (!saved) {
      throw new Error("Expected the upsert to save the item");
    }
    return parseUuidV7(saved.id);
  };

  /** Upserts a Jira-style item through `PUT /work-items`. */
  const putItem = async (platformKey: string, fields: AnyJsonObject) =>
    parseUuidV7(
      (
        await unwrapAsync(
          apiClient.api["work-items"].put(
            {
              projectId,
              platform: "jira",
              platformId: `jira-${platformKey}`,
              platformKey,
              url: `https://acme.atlassian.net/browse/${platformKey}`,
              title: `Item ${platformKey}`,
              description: "Synced",
              sourceCreatedAt: null,
              sourceUpdatedAt: null,
              fields,
            },
            { headers },
          ),
        )
      ).id,
    );

  const block = async (blockedWorkItemId: UuidV7, blockingWorkItemId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["work-item-blocks"].post(
        {
          blockedWorkItemId: parseWorkItemId(blockedWorkItemId),
          blockingWorkItemId: parseWorkItemId(blockingWorkItemId),
        },
        { headers },
      ),
    );

  const setState = async (workItemId: UuidV7, state: "open" | "closed") =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).state.put(
        state === "closed" ? { state, reason: "completed" } : { state },
        { headers },
      ),
    );

  const addLabels = async (workItemId: UuidV7, add: string[]) =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).labels.patch(
        { add },
        { headers },
      ),
    );

  /**
   * Runs a `wayfinder` Task on `workItemId` whose agent creates `children`,
   * one at a time while the run is claimed, then succeeds.
   */
  const runCreatingChildren = async (
    workItemId: UuidV7,
    children: ChildCreate[],
  ) => {
    const started = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: wayfinder.id,
          stepDefinitionVersion: wayfinder.version,
          inputJson: null,
        },
        { headers },
      ),
    );
    const taskRunId = started.run?.id;
    if (!taskRunId) {
      throw new Error("Expected the Task to start with a run");
    }
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workItemId,
          workerId: `automation-runner-${crypto.randomUUID()}`,
          batchSize: 50,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claimToken = claims.find(
      (claim) => claim.task.id === taskRunId,
    )?.claimToken;
    if (!claimToken) {
      throw new Error("Expected to claim the run");
    }
    const routes = apiClient.api["task-runs"]({ taskRunId });
    for (const child of children) {
      await unwrapAsync(
        routes["work-item-creates"].post({
          claimToken,
          ...child,
          workItemId: parseWorkItemId(child.workItemId),
          blockedBy: child.blockedBy?.map(parseWorkItemId),
        }),
      );
    }
    const run = await unwrapAsync(
      routes.completions.post(
        {
          claimToken,
          status: "succeeded",
          resultJson: { done: true },
          errorJson: null,
        },
        { headers },
      ),
    );
    if (run.status !== "succeeded") {
      throw new Error(`Expected the run to succeed, got ${run.status}`);
    }
  };

  /** The Tasks on a work item, oldest first, with their step key and input. */
  const tasksOn = async (workItemId: UuidV7) => {
    const page = await unwrapAsync(
      apiClient.api.projects({ projectId }).tasks.get({
        query: { workItemId },
        headers,
      }),
    );
    const details = await Promise.all(
      page.tasks.map(
        async (task) =>
          await unwrapAsync(
            apiClient.api.tasks({ taskId: task.id }).get({ headers }),
          ),
      ),
    );
    return details
      .map((task) => ({
        id: task.id,
        step: task.name,
        status: task.status,
        inputJson: task.inputJson,
        startedByUserId: task.startedByUserId,
        startedBy: task.startedBy,
        createdAt: task.createdAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((task) => task.step !== wayfinder.key);
  };

  /** A work item's activity messages, oldest first. */
  const activityOf = async (workItemId: UuidV7) =>
    (
      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId }).activity.get({ headers }),
      )
    ).map((entry) => entry.message);

  /** The pipeline runs on a work item, oldest first: which pipeline, and who started it. */
  const runsOn = async (workItemId: UuidV7) =>
    (
      await unwrapAsync(
        apiClient.api["pipeline-executions"].get({
          query: { projectId, workItemId, sort: "oldest" },
          headers,
        }),
      )
    ).items.map((run) => ({
      id: run.id,
      pipelineId: run.pipelineDefinitionId,
      triggeredByUserId: run.triggeredByUserId,
      startedBy: run.startedBy,
    }));

  /** Deletes the automation's row, as a removal would, leaving what it started. */
  const deleteAutomation = async (key: string) =>
    await getDb()
      .delete(automations)
      .where(
        and(eq(automations.projectId, projectId), eq(automations.key, key)),
      );

  const createPipeline = async (step: Step) =>
    await createPipelineFromDocument(
      apiClient,
      headers,
      projectId,
      singleStepPipelineDocument(
        `pipeline-${crypto.randomUUID().slice(0, 8)}`,
        step.key,
      ),
    );

  const archiveStep = async (step: Step) =>
    await unwrapAsync(
      apiClient.api["step-definitions"]({
        stepDefinitionId: step.id,
      }).archive.put(undefined, { headers }),
    );

  return {
    apiClient,
    headers,
    ownerId: parseUuidV7(owner.userId),
    projectId,
    createStep,
    publish,
    attach,
    enable,
    createItem,
    syncItem,
    putItem,
    block,
    setState,
    addLabels,
    runCreatingChildren,
    tasksOn,
    activityOf,
    runsOn,
    deleteAutomation,
    createPipeline,
    archiveStep,
  };
};

export type RunnerHarness = Awaited<ReturnType<typeof createRunnerHarness>>;

/** A child work item a run's agent creates. */
export type ChildCreate = {
  workItemId: UuidV7;
  title: string;
  description: string;
  labels?: string[];
  blockedBy?: UuidV7[];
};

export const childCreate = (
  title: string,
  extra: { labels?: string[]; blockedBy?: UuidV7[] } = {},
): ChildCreate => ({
  workItemId: createUuidV7(),
  title,
  description: `${title} description`,
  ...extra,
});

export const workItemAutomation = (key: string, rules: readonly object[]) => ({
  kind: "automation",
  schemaVersion: 1,
  key,
  title: `Automation ${key}`,
  scope: "workItem",
  rules: rules as AnyJsonObject[],
});

export const projectAutomation = (key: string, rules: readonly object[]) => ({
  kind: "automation",
  schemaVersion: 1,
  key,
  scope: "project",
  rules: rules as AnyJsonObject[],
});

export const uniqueKey = (name: string) =>
  `${name}-${crypto.randomUUID().slice(0, 8)}`;
