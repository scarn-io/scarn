import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { eq } from "drizzle-orm";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemChange } from "@/tasks/task/contracts/work-item-change-contracts";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { RecordingWorkItemEvents } from "./work-item-events-test-support";
import { grant } from "tests/tasks/task/grants-test-support";

/**
 * Work items tell `WorkItemEventsPort` what happened, in the transaction
 * that made the change: creates, closes, readiness, and labels gained.
 */
describe("work item events", () => {
  let recorder: RecordingWorkItemEvents | undefined;
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-11-02T12:00:00.000Z")),
        workItemEvents: (runner) =>
          (recorder = new RecordingWorkItemEvents(runner)),
      }),
    ),
  );
  let project: ProjectContract | undefined;
  let headers: { authorization: string } | undefined;
  let wayfinderStep: { id: UuidV7; version: number } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-events-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Events Project",
          description: "Project for work item event tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const step = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(project.id),
          key: `wayfinder_${crypto.randomUUID()}`,
          name: "wayfinder",
          description: "Step for work item event tests",
          prompt: "Do the work.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
          grants: [
            grant("label", "self", ["planned"]),
            grant("block", "children"),
            grant("close", "children"),
          ],
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    wayfinderStep = { id: parseUuidV7(step.id), version: step.version };
  });

  const requireSetup = () => {
    if (!project || !headers || !wayfinderStep || !recorder) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId: parseUuidV7(project.id),
      headers: { ...headers },
      wayfinderStep,
      recorder,
    };
  };

  const createNativeItem = async (title = "Item") => {
    const { projectId, headers } = requireSetup();
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

  const setState = async (workItemId: UuidV7, state: "open" | "closed") =>
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId }).state.put(
        state === "closed" ? { state, reason: "completed" } : { state },
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

  const syncItem = async (platformKey: string, labels: string[]) => {
    const { projectId, headers } = requireSetup();
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

  const runWayfinder = async (
    workItemId: UuidV7,
    workItemChanges: WorkItemChange[],
  ) => {
    const { projectId, headers, wayfinderStep } = requireSetup();
    const started = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId,
          stepDefinitionId: wayfinderStep.id,
          stepDefinitionVersion: wayfinderStep.version,
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
          workerId: `work-item-events-${crypto.randomUUID()}`,
          batchSize: 1,
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
    return await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).completions.post(
        {
          claimToken,
          status: "succeeded",
          resultJson: { done: true },
          errorJson: null,
          workItemChanges,
        },
        { headers },
      ),
    );
  };

  const eventNames = (ids: string[]) =>
    requireSetup()
      .recorder.about(ids)
      .map((each) => each.event);

  concurrentTest("a create tells created, then may be ready", async () => {
    const id = await createNativeItem();

    expect(requireSetup().recorder.about([id])).toEqual([
      { event: "created", workItemIds: [id], blockerCounts: { [id]: 0 } },
      {
        event: "mayHaveBecomeReady",
        workItemIds: [id],
        blockerCounts: { [id]: 0 },
      },
    ]);
  });

  concurrentTest("a close tells closed", async () => {
    const id = await createNativeItem();

    await setState(id, "closed");

    expect(eventNames([id])).toEqual([
      "created",
      "mayHaveBecomeReady",
      "closed",
    ]);
  });

  concurrentTest(
    "the blocked item may be ready when its last blocker closes",
    async () => {
      const blocked = await createNativeItem("Blocked");
      const first = await createNativeItem("First");
      const second = await createNativeItem("Second");
      await block(blocked, first);
      await block(blocked, second);
      const before = requireSetup().recorder.about([blocked]).length;

      await setState(first, "closed");
      await setState(second, "closed");

      const readiness = requireSetup()
        .recorder.about([blocked])
        .slice(before)
        .filter((each) => each.event === "mayHaveBecomeReady");
      expect(readiness).toHaveLength(2);
    },
  );

  concurrentTest("a reopened item may be ready", async () => {
    const id = await createNativeItem();
    await setState(id, "closed");

    await setState(id, "open");

    expect(eventNames([id])).toEqual([
      "created",
      "mayHaveBecomeReady",
      "closed",
      "mayHaveBecomeReady",
    ]);
  });

  concurrentTest("PATCH …/labels tells only the new labels", async () => {
    const id = await createNativeItem();
    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: id }).labels.patch(
        { add: ["a"] },
        { headers: requireSetup().headers },
      ),
    );

    await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: id }).labels.patch(
        { add: ["a", "b"] },
        { headers: requireSetup().headers },
      ),
    );

    expect(
      requireSetup()
        .recorder.about([id])
        .flatMap((each) => (each.event === "labelsAdded" ? [each.labels] : [])),
    ).toEqual([["a"], ["b"]]);
  });

  concurrentTest("a sync upsert tells only the added labels", async () => {
    const platformKey = `SYNC-${crypto.randomUUID()}`;
    const id = await syncItem(platformKey, ["x"]);

    await syncItem(platformKey, ["x", "y"]);
    await syncItem(platformKey, ["y"]);

    expect(
      requireSetup()
        .recorder.about([id])
        .map((each) =>
          each.event === "labelsAdded"
            ? ["labelsAdded", each.labels]
            : [each.event],
        ),
    ).toEqual([
      ["created"],
      ["labelsAdded", ["x"]],
      ["mayHaveBecomeReady"],
      ["labelsAdded", ["y"]],
    ]);
  });

  concurrentTest(
    "an agent run's events are told after every change, in order",
    async () => {
      const root = await createNativeItem("Root");
      const first = await createNativeItem("First");
      const second = await createNativeItem("Second");
      for (const child of [first, second]) {
        await getDb()
          .update(workItems)
          .set({ parentWorkItemId: root })
          .where(eq(workItems.id, child));
      }
      const before = requireSetup().recorder.events.length;

      const run = await runWayfinder(root, [
        { kind: "label", workItemId: root, add: ["planned"] },
        { kind: "block", blockedWorkItemId: second, blockingWorkItemId: first },
        { kind: "close", workItemId: first, reason: "completed" },
      ]);
      expect(run.status).toBe("succeeded");

      const told = requireSetup()
        .recorder.events.slice(before)
        .filter((each) =>
          each.event === "labelsAdded"
            ? [root, first, second].includes(each.workItemId)
            : each.workItemIds.some((id) => [first, second].includes(id)),
        );
      expect(told).toEqual([
        {
          event: "labelsAdded",
          workItemId: root,
          labels: ["planned"],
          labelsOnItem: ["planned"],
        },
        {
          event: "closed",
          workItemIds: [first],
          blockerCounts: { [first]: 0 },
        },
        {
          event: "mayHaveBecomeReady",
          workItemIds: [second],
          blockerCounts: { [second]: 1 },
        },
      ]);
    },
  );
});
