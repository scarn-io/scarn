import { beforeAll, describe, expect } from "bun:test";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import {
  createRunsProject,
  listRuns,
  type RunsProject,
} from "./project-runs-test-support";
import {
  seedPipelineRunCases,
  seedTaskAndChatCases,
} from "./project-runs-cases";

/** The Runs list's tab and sidebar counts. */
describe("project runs: counts", () => {
  let project: RunsProject;
  let pipelineId: UuidV7;
  let stepDefinitionId: UuidV7;
  let automationId: UuidV7;

  beforeAll(async () => {
    project = await createRunsProject();
    pipelineId = (await seedPipelineRunCases(project)).pipeline.id;
    ({ stepDefinitionId, automationId } = await seedTaskAndChatCases(project));
  });

  concurrentTest("counts each tab and facet for the viewer", async () => {
    const { counts } = await listRuns(project.owner, project.projectId, {
      status: "finished",
      limit: 1,
    });
    expect(counts.tabs).toEqual({
      "needs-you": 4,
      open: 10,
      finished: 9,
      all: 19,
    });
    expect(counts.overall).toEqual({ inProgress: 10, needsYou: true });
    expect(counts.startedBy).toEqual([
      { filter: "me", label: "You", inProgress: 2, needsYou: true },
      {
        filter: automationId,
        label: "Nightly triage",
        inProgress: 0,
        needsYou: false,
      },
    ]);
    expect(counts.whatRan).toEqual([
      {
        filter: pipelineId,
        whatRan: { kind: "pipeline", id: pipelineId, name: "Review" },
        inProgress: 4,
        needsYou: true,
      },
      {
        filter: stepDefinitionId,
        whatRan: { kind: "step", id: stepDefinitionId, name: "Triage" },
        inProgress: 0,
        needsYou: false,
      },
      {
        filter: "task",
        whatRan: { kind: "task", name: "Task" },
        inProgress: 6,
        needsYou: true,
      },
    ]);
  });

  concurrentTest(
    "tabs follow every filter; a facet ignores only its own",
    async () => {
      const { counts } = await listRuns(project.owner, project.projectId, {
        whatRan: "task",
      });
      expect(counts.tabs).toEqual({
        "needs-you": 2,
        open: 6,
        finished: 4,
        all: 10,
      });
      expect(counts.overall.inProgress).toBe(10);
      expect(counts.startedBy[0]).toEqual({
        filter: "me",
        label: "You",
        inProgress: 2,
        needsYou: true,
      });
      expect(counts.whatRan.map((entry) => entry.filter)).toContain(pipelineId);
    },
  );

  concurrentTest("another member's needs-you differs", async () => {
    const { counts } = await listRuns(project.member, project.projectId);
    expect(counts.tabs["needs-you"]).toBe(1);
    expect(counts.tabs.open).toBe(10);
  });
});
