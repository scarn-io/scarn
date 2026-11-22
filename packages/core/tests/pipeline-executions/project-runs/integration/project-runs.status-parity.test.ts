import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { projectRunStatusValues } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { concurrentTest } from "tests/utils";
import {
  appContext,
  createRunsProject,
  listRuns,
  type RunsProject,
} from "./project-runs-test-support";
import {
  seedPipelineRunCases,
  seedTaskAndChatCases,
} from "./project-runs-cases";

/**
 * The status the reader derives in SQL (which filters, tabs and counts use)
 * agrees with the one the use case derives on the hydrated row, for every
 * seeded case and every kind of viewer.
 */
describe("project runs: SQL and hydrated statuses agree", () => {
  let project: RunsProject;

  beforeAll(async () => {
    project = await createRunsProject();
    await seedPipelineRunCases(project);
    await seedTaskAndChatCases(project);
  });

  const sqlStatuses = async (viewerUserId: string | null) => {
    const keys = await appContext.projectRunsReader.listPage(
      {
        projectId: project.projectId,
        viewerUserId: viewerUserId === null ? null : parseUuidV7(viewerUserId),
        actorUserId: project.owner.userId as never,
      },
      { statuses: projectRunStatusValues, limit: 100 },
    );
    return new Map(keys.map((key) => [key.id, key.status]));
  };

  for (const viewer of ["owner", "member"] as const) {
    concurrentTest(`as the ${viewer}`, async () => {
      const userId = project[viewer].userId;
      const [page, statuses] = await Promise.all([
        listRuns(project[viewer], project.projectId),
        sqlStatuses(userId),
      ]);
      expect(page.runs).toHaveLength(19);
      expect(
        page.runs.map((run) => [run.id, run.type, statuses.get(run.id)]),
      ).toEqual(page.runs.map((run) => [run.id, run.type, run.status]));
    });
  }

  concurrentTest("as a guest, whom nothing waits on", async () => {
    const statuses = await sqlStatuses(null);
    expect([...statuses.values()]).not.toContain("needs-you");
    expect(statuses.size).toBe(19);
  });
});
