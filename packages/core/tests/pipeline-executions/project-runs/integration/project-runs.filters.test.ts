import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import {
  createRunsProject,
  listRuns,
  seedAutomation,
  seedChat,
  seedPipeline,
  seedRun,
  seedStepDefinition,
  seedTask,
  seedVisit,
  seedWorkItem,
  type RunsProject,
} from "./project-runs-test-support";

/** The Runs list's filters, search and paging. */
describe("project runs: filters, search and paging", () => {
  let project: RunsProject;
  const ids = {} as Record<
    "parentRun" | "childRun" | "otherRun" | "childTask" | "otherTask" | "chat",
    UuidV7
  >;
  let review: Awaited<ReturnType<typeof seedPipeline>>;
  let parentId: UuidV7;
  let stepDefinitionId: UuidV7;
  let automationId: UuidV7;

  beforeAll(async () => {
    project = await createRunsProject();
    const { projectId, owner } = project;
    review = await seedPipeline(projectId, "Review");
    const deploy = await seedPipeline(projectId, "Deploy");
    stepDefinitionId = await seedStepDefinition(projectId, "Triage");
    automationId = await seedAutomation(projectId, "Nightly");
    const parent = await seedWorkItem({ projectId, title: "Epic" });
    parentId = parent.id;
    const child = await seedWorkItem({
      projectId,
      title: "Child story",
      parentWorkItemId: parent.id,
    });
    const other = await seedWorkItem({ projectId, title: "Unrelated" });

    ids.parentRun = await seedRun({
      projectId,
      pipeline: review,
      workItemId: parent.id,
      status: "active",
      minute: 1,
      triggeredByUserId: owner.userId,
    });
    await seedVisit({
      runId: ids.parentRun,
      nodeId: "build",
      nodeKind: "step",
      status: "active",
    });
    ids.childRun = await seedRun({
      projectId,
      pipeline: review,
      workItemId: child.id,
      status: "failed",
      minute: 2,
      automationId,
    });
    await seedVisit({
      runId: ids.childRun,
      nodeId: "lint",
      nodeKind: "step",
      status: "failed",
      error: { name: "Lint", message: "eslint found zebra-unicorn" },
    });
    ids.otherRun = await seedRun({
      projectId,
      pipeline: deploy,
      workItemId: other.id,
      status: "active",
      minute: 3,
    });
    await seedVisit({
      runId: ids.otherRun,
      nodeId: "lint",
      nodeKind: "step",
      status: "active",
    });
    ids.childTask = await seedTask({
      projectId,
      workItemId: child.id,
      status: "succeeded",
      minute: 4,
      stepDefinitionId,
      automationId,
    });
    ids.otherTask = await seedTask({
      projectId,
      workItemId: other.id,
      status: "running",
      minute: 5,
      prompt: "Rename the walrus module",
      startedByUserId: owner.userId,
    });
    ids.chat = (
      await seedChat({
        projectId,
        taskStatus: "running",
        minute: 6,
        createdByUserId: owner.userId,
        question: "Where is the narwhal config?",
      })
    ).taskId;
  });

  const listIds = async (query: Parameters<typeof listRuns>[2]) =>
    (await listRuns(project.owner, project.projectId, query)).runs.map(
      (run) => run.id,
    );

  concurrentTest("workItemId matches the item and its children", async () => {
    expect(await listIds({ workItemId: parentId })).toEqual([
      ids.childTask,
      ids.childRun,
      ids.parentRun,
    ]);
  });

  concurrentTest("whatRan narrows to a pipeline, step or task", async () => {
    expect(await listIds({ whatRan: review.id })).toEqual([
      ids.childRun,
      ids.parentRun,
    ]);
    expect(await listIds({ whatRan: stepDefinitionId })).toEqual([
      ids.childTask,
    ]);
    expect(await listIds({ whatRan: "task" })).toEqual([
      ids.chat,
      ids.otherTask,
    ]);
  });

  concurrentTest(
    "startedBy narrows to an automation or the viewer",
    async () => {
      expect(await listIds({ startedBy: automationId })).toEqual([
        ids.childTask,
        ids.childRun,
      ]);
      expect(await listIds({ startedBy: "me" })).toEqual([
        ids.chat,
        ids.otherTask,
        ids.parentRun,
      ]);
    },
  );

  concurrentTest(
    "atNode keeps a pipeline's runs open at the node",
    async () => {
      expect(await listIds({ whatRan: review.id, atNode: "build" })).toEqual([
        ids.parentRun,
      ]);
      expect(await listIds({ whatRan: review.id, atNode: "lint" })).toEqual([]);
    },
  );

  concurrentTest("status narrows to a tab or one status", async () => {
    expect(await listIds({ status: "finished" })).toEqual([
      ids.childTask,
      ids.childRun,
    ]);
    expect(await listIds({ status: "failed" })).toEqual([ids.childRun]);
    expect(await listIds({ status: "needs-you" })).toEqual([]);
  });

  concurrentTest(
    "q matches titles, keys, names, prompts, errors, node ids and messages",
    async () => {
      expect(await listIds({ q: "child STORY" })).toEqual([
        ids.childTask,
        ids.childRun,
      ]);
      expect(await listIds({ q: "deploy" })).toEqual([ids.otherRun]);
      expect(await listIds({ q: "triage" })).toEqual([ids.childTask]);
      expect(await listIds({ q: "walrus" })).toEqual([ids.otherTask]);
      expect(await listIds({ q: "zebra-unicorn" })).toEqual([ids.childRun]);
      expect(await listIds({ q: "build" })).toEqual([ids.parentRun]);
      expect(await listIds({ q: "narwhal" })).toEqual([ids.chat]);
      expect(await listIds({ q: "100%_" })).toEqual([]);
    },
  );

  concurrentTest("pages by updatedAt with an opaque cursor", async () => {
    const first = await listRuns(project.owner, project.projectId, {
      limit: 4,
    });
    expect(first.runs.map((run) => run.id)).toEqual([
      ids.chat,
      ids.otherTask,
      ids.childTask,
      ids.otherRun,
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listRuns(project.owner, project.projectId, {
      limit: 4,
      before: first.nextCursor ?? "",
    });
    expect(second.runs.map((run) => run.id)).toEqual([
      ids.childRun,
      ids.parentRun,
    ]);
    expect(second.nextCursor).toBeNull();
  });
});
