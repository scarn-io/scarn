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
  TEXT_SIGNAL_KEY,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * Signal-score sorting for `GET /projects/:projectId/work-items`.
 *
 * The score comes from a `LEFT JOIN` against the latest numeric signal per work
 * item, so the load-bearing behaviors are: unscored items sort last in *both*
 * directions (Postgres defaults `DESC` to `NULLS FIRST`), a non-numeric signal
 * degrades to `null` instead of erroring, and `signalScore` rides along on each
 * item so the UI no longer needs a separate scores request.
 */
describe("project work items signal sort", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  let project: ListingProject | undefined;
  let pipelineDefinitionId: UuidV7 | undefined;

  beforeAll(
    async () => {
      project = await createListingProject(apiClient, "signal-sort");
      pipelineDefinitionId = await createScoringPipeline(apiClient, project);

      const workItems = await seedWorkItems(apiClient, project, [
        { title: "scored twenty" },
        { title: "scored ten" },
        { title: "scored five" },
        { title: "never scored" },
      ]);

      // One execution per item emits both the numeric and the string signal, so
      // the same fixture serves the numeric-sort and non-numeric-signal cases.
      const scores = [20, 10, 5];
      for (const [index, score] of scores.entries()) {
        const workItem = workItems[index];
        if (!workItem)
          throw new Error("Expected the fixture work item to exist");
        await recordSignalScore(
          apiClient,
          project,
          pipelineDefinitionId,
          workItem.id,
          { score, scoreText: `text-${String(score)}` },
        );
      }
      // Several sequential DB-backed HTTP round trips against the real app;
      // comfortably under 5s locally but tight under CI load, so give this
      // hook more room than bun:test's default 5000ms.
    },
    { timeout: 20_000 },
  );

  const fixture = (): ListingProject => {
    if (!project) throw new Error("Expected the sort fixture to be seeded");
    return project;
  };

  const sortPipelineId = (): UuidV7 => {
    if (!pipelineDefinitionId) {
      throw new Error("Expected the scoring pipeline to be created");
    }
    return pipelineDefinitionId;
  };

  /** Builds a `score:<pipelineId>:<stepKey>:<signalKey>:<direction>` sort token. */
  const scoreToken = (options: {
    signalKey?: string;
    stepKey?: string;
    direction?: "asc" | "desc";
  }): string =>
    `score:${sortPipelineId()}:${options.stepKey ?? SCORE_STEP_KEY}:${
      options.signalKey ?? NUMERIC_SIGNAL_KEY
    }:${options.direction ?? "desc"}`;

  const listSorted = async (options: {
    signalKey?: string;
    stepKey?: string;
    direction?: "asc" | "desc";
  }) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: fixture().projectId })
        ["work-items"].get({
          query: {
            page: 1,
            pageSize: 25,
            sort: scoreToken(options),
          },
          headers: { ...fixture().authHeaders },
        }),
    );

  concurrentTest("sorts descending with unscored items last", async () => {
    const page = await listSorted({ direction: "desc" });

    expect(page.items.map((item) => [item.title, item.signalScore])).toEqual([
      ["scored twenty", 20],
      ["scored ten", 10],
      ["scored five", 5],
      ["never scored", null],
    ]);
    expect(page.pagination.total).toBe(4);
  });

  concurrentTest("sorts ascending with unscored items last", async () => {
    const page = await listSorted({ direction: "asc" });

    expect(page.items.map((item) => [item.title, item.signalScore])).toEqual([
      ["scored five", 5],
      ["scored ten", 10],
      ["scored twenty", 20],
      ["never scored", null],
    ]);
  });

  concurrentTest(
    "keeps unscored items last on the final page when paging a sort",
    async () => {
      const page = await unwrapAsync(
        apiClient.api
          .projects({ projectId: fixture().projectId })
          ["work-items"].get({
            query: {
              page: 2,
              pageSize: 2,
              sort: scoreToken({ direction: "desc" }),
            },
            headers: { ...fixture().authHeaders },
          }),
      );

      expect(page.items.map((item) => item.title)).toEqual([
        "scored five",
        "never scored",
      ]);
      expect(page.pagination).toEqual({ page: 2, pageSize: 2, total: 4 });
    },
  );

  concurrentTest(
    "a non-numeric signal yields a null score rather than an error",
    async () => {
      const page = await listSorted({
        signalKey: TEXT_SIGNAL_KEY,
        direction: "desc",
      });

      expect(page.pagination.total).toBe(4);
      expect(page.items).toHaveLength(4);
      expect(page.items.map((item) => item.signalScore)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    },
  );

  concurrentTest("an unknown signal key leaves every score null", async () => {
    const page = await listSorted({ signalKey: "no_such_signal" });

    expect(page.pagination.total).toBe(4);
    expect(page.items.map((item) => item.signalScore)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  concurrentTest("an unknown step key leaves every score null", async () => {
    const page = await listSorted({ stepKey: "no-such-step" });

    expect(page.pagination.total).toBe(4);
    expect(page.items.map((item) => item.signalScore)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  concurrentTest(
    "a malformed score token is dropped rather than rejected",
    async () => {
      // Missing the `:<signalKey>:<direction>` tail, so
      // `parseWorkItemSortToken` fails to match and the default ordering
      // applies — no join happens, so every score is null.
      const page = await unwrapAsync(
        apiClient.api
          .projects({ projectId: fixture().projectId })
          ["work-items"].get({
            query: {
              page: 1,
              pageSize: 25,
              sort: `score:${sortPipelineId()}:${SCORE_STEP_KEY}`,
            },
            headers: { ...fixture().authHeaders },
          }),
      );

      expect(page.pagination.total).toBe(4);
      expect(page.items.map((item) => item.signalScore)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    },
  );
});
