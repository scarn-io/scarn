import { beforeAll, describe, expect } from "bun:test";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import {
  createOutsider,
  createRunsProject,
  listRuns,
  markProjectPublic,
  seedChat,
  seedPipeline,
  seedRun,
  seedStepDefinition,
  seedTask,
  seedVisit,
  seedWorkItem,
  type RunsProject,
} from "./project-runs-test-support";
import { readRun, readRunError } from "./project-runs-single-support";

/** `GET /projects/:projectId/runs/:type/:id`: one row, as the list derives it. */
describe("project runs: one run", () => {
  let project: RunsProject;
  let publicProject: RunsProject;
  let runId: UuidV7;
  let stepTaskId: UuidV7;
  let promptTaskId: UuidV7;
  let visitTaskId: UuidV7;
  let chatTaskId: UuidV7;

  beforeAll(async () => {
    [project, publicProject] = await Promise.all([
      createRunsProject(),
      createRunsProject(),
    ]);
    await markProjectPublic(publicProject.projectId);
    const { projectId, owner } = project;
    const parent = await seedWorkItem({ projectId, title: "Parent" });
    const workItem = await seedWorkItem({
      projectId,
      title: "Fix login",
      parentWorkItemId: parent.id,
      createdByUserId: owner.userId,
    });
    const pipeline = await seedPipeline(projectId);
    runId = await seedRun({
      projectId,
      pipeline,
      workItemId: workItem.id,
      status: "waiting",
      minute: 1,
      triggeredByUserId: owner.userId,
    });
    await seedVisit({
      runId,
      nodeId: "ask",
      nodeKind: "wait",
      status: "waiting",
    });
    visitTaskId = await seedTask({
      projectId,
      workItemId: workItem.id,
      status: "succeeded",
      minute: 2,
    });
    await seedVisit({
      runId,
      nodeId: "build",
      nodeKind: "step",
      status: "succeeded",
      taskId: visitTaskId,
    });
    stepTaskId = await seedTask({
      projectId,
      workItemId: workItem.id,
      status: "running",
      minute: 3,
      stepDefinitionId: await seedStepDefinition(projectId, "Build"),
      startedByUserId: owner.userId,
    });
    promptTaskId = await seedTask({
      projectId,
      workItemId: workItem.id,
      status: "succeeded",
      minute: 4,
      prompt: "Tidy the README",
    });
    ({ taskId: chatTaskId } = await seedChat({
      projectId,
      taskStatus: "waiting_for_person",
      minute: 5,
      createdByUserId: owner.userId,
      question: "Where is auth handled?",
    }));
  });

  concurrentTest("each kind reads the same as its list row", async () => {
    const { runs } = await listRuns(project.owner, project.projectId, {
      status: "all",
    });
    const lookups = [
      { type: "pipeline" as const, id: runId },
      { type: "task" as const, id: stepTaskId },
      { type: "task" as const, id: promptTaskId },
      { type: "task" as const, id: chatTaskId },
    ];
    for (const lookup of lookups) {
      const row = runs.find((run) => run.id === lookup.id);
      if (!row) throw new Error(`No list row for ${lookup.id}`);
      expect(await readRun(project.owner, project.projectId, lookup)).toEqual(
        row,
      );
    }
  });

  concurrentTest("derives the status for the viewer", async () => {
    const run = await readRun(project.owner, project.projectId, {
      type: "pipeline",
      id: runId,
    });
    expect(run).toMatchObject({
      type: "pipeline",
      href: `runs/${runId}`,
      title: "Fix login",
      status: "needs-you",
      waitingOnYou: true,
      workItem: { title: "Fix login", parent: { title: "Parent" } },
    });
    const step = await readRun(project.owner, project.projectId, {
      type: "task",
      id: stepTaskId,
    });
    expect(step).toMatchObject({
      type: "step",
      status: "running",
      whatRan: { kind: "step", name: "Build" },
    });
    expect(
      await readRun(project.member, project.projectId, {
        type: "task",
        id: chatTaskId,
      }),
    ).toMatchObject({
      type: "task",
      href: `runs/tasks/${chatTaskId}`,
      title: "Where is auth handled?",
      workItem: null,
      status: "waiting",
      waitingOnYou: false,
    });
  });

  concurrentTest("a Task run by a node visit is not found", async () => {
    expect(
      await readRunError(project.owner, project.projectId, {
        type: "task",
        id: visitTaskId,
      }),
    ).toMatchObject({ status: 404 });
  });

  concurrentTest("an id of another kind is not found", async () => {
    expect(
      await readRunError(project.owner, project.projectId, {
        type: "pipeline",
        id: stepTaskId,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await readRunError(project.owner, project.projectId, {
        type: "task",
        id: runId,
      }),
    ).toMatchObject({ status: 404 });
  });

  concurrentTest("an unknown id or project is not found", async () => {
    expect(
      await readRunError(project.owner, project.projectId, {
        type: "pipeline",
        id: createUuidV7(),
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await readRunError(project.owner, createUuidV7(), {
        type: "pipeline",
        id: runId,
      }),
    ).toMatchObject({ status: 404 });
  });

  concurrentTest("another project's run is not found", async () => {
    expect(
      await readRunError(publicProject.owner, publicProject.projectId, {
        type: "pipeline",
        id: runId,
      }),
    ).toMatchObject({ status: 404 });
  });

  concurrentTest("a non-member of a private project is refused", async () => {
    const outsider = await createOutsider();
    expect(
      await readRunError(outsider, project.projectId, {
        type: "pipeline",
        id: runId,
      }),
    ).toMatchObject({ status: 403 });
    expect(
      await readRunError(null, project.projectId, {
        type: "pipeline",
        id: runId,
      }),
    ).toMatchObject({ status: 401 });
  });

  concurrentTest(
    "a public project's guest reads a run, waiting on nobody they are",
    async () => {
      const { projectId, owner } = publicProject;
      const { taskId: chatId } = await seedChat({
        projectId,
        taskStatus: "waiting_for_person",
        minute: 1,
        createdByUserId: owner.userId,
      });
      const outsider = await createOutsider();
      for (const viewer of [outsider, null]) {
        expect(
          await readRun(viewer, projectId, { type: "task", id: chatId }),
        ).toMatchObject({ status: "waiting", waitingOnYou: false });
      }
      expect(
        await readRun(owner, projectId, { type: "task", id: chatId }),
      ).toMatchObject({ status: "needs-you" });
    },
  );

  concurrentTest("an unknown type is rejected", async () => {
    expect(
      await readRunError(project.owner, project.projectId, {
        type: "step" as "task",
        id: stepTaskId,
      }),
    ).toMatchObject({ status: 422 });
  });
});
