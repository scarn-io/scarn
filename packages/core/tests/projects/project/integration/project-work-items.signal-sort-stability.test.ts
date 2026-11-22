import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  createListingProject,
  createScoringPipeline,
  NUMERIC_SIGNAL_KEY,
  recordSignalScore,
  SCORE_STEP_KEY,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * The two ways a scored listing can go wrong at the SQL level:
 *
 * 1. **Join fan-out.** A work item with several scoring executions must still
 *    contribute one row, or `COUNT(*) OVER ()` reports a total larger than the
 *    number of work items and the page silently contains duplicates.
 * 2. **Unstable paging.** When scores and every timestamp tie, only the `id`
 *    tiebreaker keeps an item from appearing on two pages (or none).
 */
describe("project work items signal sort stability", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const listSorted = async (
    project: ListingProject,
    pipelineDefinitionId: UuidV7,
    query: { page: number; pageSize: number },
  ) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        ["work-items"].get({
          query: {
            ...query,
            sort: `score:${pipelineDefinitionId}:${SCORE_STEP_KEY}:${NUMERIC_SIGNAL_KEY}:desc`,
          },
          headers: { ...project.authHeaders },
        }),
    );

  describe("multiple scoring executions per work item", () => {
    let project: ListingProject | undefined;
    let pipelineDefinitionId: UuidV7 | undefined;

    beforeAll(
      async () => {
        project = await createListingProject(apiClient, "sort-fan-out");
        pipelineDefinitionId = await createScoringPipeline(apiClient, project);

        const [rescored, scoredOnce] = await seedWorkItems(apiClient, project, [
          { title: "rescored" },
          { title: "scored once" },
          { title: "never scored" },
        ]);
        if (!rescored || !scoredOnce) {
          throw new Error("Expected the fixture work items to exist");
        }

        // Two executions for the same work item: the later one must win.
        await recordSignalScore(
          apiClient,
          project,
          pipelineDefinitionId,
          rescored.id,
          { score: 1 },
        );
        await recordSignalScore(
          apiClient,
          project,
          pipelineDefinitionId,
          rescored.id,
          { score: 99 },
        );
        await recordSignalScore(
          apiClient,
          project,
          pipelineDefinitionId,
          scoredOnce.id,
          { score: 50 },
        );
        // Several sequential DB-backed HTTP round trips against the real app;
        // comfortably under 5s locally but tight under CI load, so give this
        // hook more room than bun:test's default 5000ms.
      },
      { timeout: 20_000 },
    );

    concurrentTest(
      "reports one row per work item and the latest score",
      async () => {
        if (!project || !pipelineDefinitionId) {
          throw new Error("Expected the fan-out fixture to be seeded");
        }

        const page = await listSorted(project, pipelineDefinitionId, {
          page: 1,
          pageSize: 25,
        });

        // Three work items, four executions: the total must not be inflated.
        expect(page.pagination.total).toBe(3);
        expect(
          page.items.map((item) => [item.title, item.signalScore]),
        ).toEqual([
          ["rescored", 99],
          ["scored once", 50],
          ["never scored", null],
        ]);
      },
    );
  });

  describe("identical scores and timestamps", () => {
    let project: ListingProject | undefined;
    let pipelineDefinitionId: UuidV7 | undefined;
    let seededIds: string[] = [];

    beforeAll(
      async () => {
        project = await createListingProject(apiClient, "sort-tied");
        pipelineDefinitionId = await createScoringPipeline(apiClient, project);

        const workItems = await seedWorkItems(
          apiClient,
          project,
          Array.from({ length: 5 }, (_unused, index) => ({
            title: `Tied scored item ${String(index)}`,
            sourceUpdatedAt: "2026-04-24T10:00:00.000Z",
          })),
        );
        seededIds = workItems.map((workItem) => workItem.id);

        for (const workItem of workItems) {
          await recordSignalScore(
            apiClient,
            project,
            pipelineDefinitionId,
            workItem.id,
            { score: 7 },
          );
        }
        // Five work items x three sequential calls each in recordSignalScore,
        // on top of project/pipeline setup, easily exceeds bun:test's default
        // 5000ms hook timeout under CI load (observed failing at ~5005ms).
      },
      { timeout: 20_000 },
    );

    concurrentTest(
      "paging a fully tied sort yields every item exactly once",
      async () => {
        if (!project || !pipelineDefinitionId) {
          throw new Error("Expected the tied fixture to be seeded");
        }

        const collected: string[] = [];
        for (const page of [1, 2, 3]) {
          const result = await listSorted(project, pipelineDefinitionId, {
            page,
            pageSize: 2,
          });
          expect(result.pagination.total).toBe(5);
          expect(
            result.items.every((item) => item.signalScore === 7),
          ).toBeTrue();
          collected.push(...result.items.map((item) => item.id));
        }

        expect(new Set(collected).size).toBe(collected.length);
        expect([...collected].sort()).toEqual([...seededIds].sort());
        // Every other ordering column ties, so `id DESC` alone fixes the order.
        expect(collected).toEqual([...seededIds].sort().reverse());
      },
    );
  });
});
