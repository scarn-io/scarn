import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  at,
  createRunsProject,
  listRuns,
  type RunsProject,
} from "./project-runs-test-support";
import { seedPipelineRunCases, byId } from "./project-runs-cases";

/** Pipeline run rows of the Runs list, one per status. */
describe("project runs: pipeline runs", () => {
  let project: RunsProject;
  let ids: Awaited<ReturnType<typeof seedPipelineRunCases>>["ids"];
  let stepTaskId: string;

  beforeAll(async () => {
    project = await createRunsProject();
    ({ ids, stepTaskId } = await seedPipelineRunCases(project));
  });

  concurrentTest("derives each status and status line", async () => {
    const page = await listRuns(project.owner, project.projectId);
    const rows = byId(page);
    const row = (key: keyof typeof ids) => rows.get(ids[key]);
    expect(row("queued")).toMatchObject({
      type: "pipeline",
      status: "queued",
      title: "Queued work",
      statusLine: "Queued at build",
      openNodeIds: ["build"],
      href: `runs/${ids.queued}`,
    });
    expect(row("running")).toMatchObject({
      status: "running",
      statusLine: "Running lint",
    });
    expect(row("waiting")).toMatchObject({
      status: "needs-you",
      statusLine: "Which database should we use?",
      waitingOnYou: true,
    });
    expect(row("waiting")?.waitingOn.map((person) => person.userId)).toEqual([
      project.owner.userId as never,
    ]);
    expect(row("decision")).toMatchObject({
      status: "needs-you",
      statusLine: "Waiting for your decision at approve",
    });
    expect(row("done")).toMatchObject({
      status: "done",
      statusLine: "Finished at done",
      outcome: null,
    });
    expect(row("ended")).toMatchObject({
      status: "ended",
      statusLine: "Rejected by review",
      outcome: "Rejected by review",
    });
    expect(row("failed")).toMatchObject({
      status: "failed",
      statusLine: "tsc exited with 2",
      outcome: "Scarn.StepFailed",
    });
    expect(row("cancelled")).toMatchObject({
      status: "cancelled",
      statusLine: "Cancelled",
    });
    expect(row("done")?.whatRan).toMatchObject({
      kind: "pipeline",
      name: "Review",
    });
    expect(row("done")?.workItem).toMatchObject({
      title: "Done work",
      parent: null,
    });
    expect(page.runs.map((run) => run.updatedAt)).toEqual(
      [8, 7, 6, 5, 4, 3, 2, 1].map((minute) => at(minute).toISOString()),
    );
  });

  concurrentTest("a step Task owned by a visit is not a row", async () => {
    const page = await listRuns(project.owner, project.projectId);
    expect(page.runs.map((run) => run.id)).not.toContain(stepTaskId as never);
    expect(page.runs).toHaveLength(8);
  });

  concurrentTest(
    "a wait on someone else is waiting, not needs-you",
    async () => {
      const rows = byId(await listRuns(project.member, project.projectId));
      expect(rows.get(ids.waiting)).toMatchObject({
        status: "waiting",
        waitingOnYou: false,
      });
      expect(rows.get(ids.decision)).toMatchObject({
        status: "waiting",
        statusLine: "Waiting for a decision at approve",
      });
    },
  );
});
