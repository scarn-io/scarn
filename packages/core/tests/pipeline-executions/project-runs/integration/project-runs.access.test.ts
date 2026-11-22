import { beforeAll, describe, expect } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import {
  createOutsider,
  createRunsProject,
  listRuns,
  listRunsError,
  markProjectPublic,
  type RunsProject,
} from "./project-runs-test-support";
import {
  seedPipelineRunCases,
  seedTaskAndChatCases,
} from "./project-runs-cases";

/** Who may read `GET /projects/:projectId/runs`, and the queries it rejects. */
describe("project runs: access and validation", () => {
  let project: RunsProject;
  let publicProject: RunsProject;

  beforeAll(async () => {
    [project, publicProject] = await Promise.all([
      createRunsProject(),
      createRunsProject(),
    ]);
    await markProjectPublic(publicProject.projectId);
    await seedPipelineRunCases(publicProject);
    await seedTaskAndChatCases(publicProject);
  });

  concurrentTest("a non-member of a private project is refused", async () => {
    const outsider = await createOutsider();
    expect(await listRunsError(outsider, project.projectId)).toMatchObject({
      status: 403,
    });
  });

  concurrentTest(
    "an anonymous visitor to a private project must sign in",
    async () => {
      expect(await listRunsError(null, project.projectId)).toMatchObject({
        status: 401,
      });
    },
  );

  concurrentTest("an unknown project is not found", async () => {
    expect(await listRunsError(project.owner, createUuidV7())).toMatchObject({
      status: 404,
    });
  });

  concurrentTest(
    "a public project's guest sees every row, none waiting on them",
    async () => {
      const outsider = await createOutsider();
      const page = await listRuns(outsider, publicProject.projectId);
      expect(page.runs).toHaveLength(19);
      expect(page.runs.some((run) => run.waitingOnYou)).toBe(false);
      expect(page.runs.some((run) => run.status === "needs-you")).toBe(false);
      expect(page.counts.tabs["needs-you"]).toBe(0);
      expect(page.counts.overall.needsYou).toBe(false);
      expect(page.counts.startedBy.map((entry) => entry.filter)).not.toContain(
        "me",
      );
    },
  );

  concurrentTest(
    "an anonymous visitor to a public project reads it",
    async () => {
      const page = await listRuns(null, publicProject.projectId);
      expect(page.runs).toHaveLength(19);
      expect(page.runs.some((run) => run.waitingOnYou)).toBe(false);
    },
  );

  concurrentTest("parses the query string", async () => {
    const page = await listRuns(publicProject.owner, publicProject.projectId, {
      status: "finished",
      limit: "1",
    });
    expect(page.runs).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(page.counts.tabs.finished).toBeGreaterThan(1);
  });

  concurrentTest("an unknown status is rejected", async () => {
    expect(
      await listRunsError(project.owner, project.projectId, {
        status: "sideways",
      }),
    ).toMatchObject({ status: 422 });
  });

  concurrentTest("a limit over 100 is rejected", async () => {
    expect(
      await listRunsError(project.owner, project.projectId, { limit: "101" }),
    ).toMatchObject({ status: 422 });
  });

  concurrentTest("atNode needs a pipeline whatRan", async () => {
    expect(
      await listRunsError(project.owner, project.projectId, {
        atNode: "build",
      }),
    ).toMatchObject({
      status: 422,
      code: "PROJECT_RUNS_AT_NODE_NEEDS_PIPELINE",
    });
    expect(
      await listRunsError(project.owner, project.projectId, {
        whatRan: "task",
        atNode: "build",
      }),
    ).toMatchObject({ status: 422 });
  });

  concurrentTest("a malformed cursor is rejected", async () => {
    expect(
      await listRunsError(project.owner, project.projectId, {
        before: "not-a-cursor",
      }),
    ).toMatchObject({
      status: 422,
      code: "INVALID_PROJECT_RUNS_CURSOR",
    });
  });
});
