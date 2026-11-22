import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  createListingProject,
  createScoringPipeline,
  recordExecutionResult,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * `latestExecutionStatus` for `GET /projects/:projectId/work-items`.
 *
 * The status comes from a `DISTINCT ON (work_item_id)` `LEFT JOIN`
 * (`buildLatestExecutionStatusSubquery`) against every pipeline execution the
 * work item has run through, so the load-bearing behaviors are: a work item
 * with no execution reports `null` (not `"queued"`), the *newest* execution's
 * status wins over an older one, and the collapse keeps the join 1:1 so
 * `pagination.total` never counts an execution instead of a work item.
 *
 * One shared project + pipeline for the whole suite (each `concurrentTest`
 * runs against the real API and testcontainers Postgres); every assertion
 * scopes to its own work item(s) via a unique title and the `q` search param,
 * so concurrent tests never see each other's rows.
 */
describe("project work items latest execution status", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  let project: ListingProject | undefined;
  let pipelineDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    project = await createListingProject(apiClient, "latest-execution-status");
    pipelineDefinitionId = await createScoringPipeline(apiClient, project);
  });

  const fixture = (): ListingProject => {
    if (!project) throw new Error("Expected the status fixture to be seeded");
    return project;
  };

  const pipelineId = (): UuidV7 => {
    if (!pipelineDefinitionId) {
      throw new Error("Expected the scoring pipeline to be created");
    }
    return pipelineDefinitionId;
  };

  const listByTitlePrefix = async (titlePrefix: string) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: fixture().projectId })
        ["work-items"].get({
          query: { page: 1, pageSize: 25, q: titlePrefix },
          headers: { ...fixture().authHeaders },
        }),
    );

  concurrentTest(
    "a work item with a succeeded execution reports 'succeeded'",
    async () => {
      const titlePrefix = `succeeded-status-${crypto.randomUUID()}`;
      const [workItem] = await seedWorkItems(apiClient, fixture(), [
        { title: titlePrefix },
      ]);
      if (!workItem) throw new Error("Expected the seeded work item to exist");

      await recordExecutionResult(
        apiClient,
        fixture(),
        pipelineId(),
        workItem.id,
        "succeeded",
      );

      const page = await listByTitlePrefix(titlePrefix);

      expect(page.items.map((item) => item.latestExecutionStatus)).toEqual([
        "succeeded",
      ]);
    },
  );

  concurrentTest(
    "a work item with no execution at all reports null",
    async () => {
      const titlePrefix = `no-execution-status-${crypto.randomUUID()}`;
      await seedWorkItems(apiClient, fixture(), [{ title: titlePrefix }]);

      const page = await listByTitlePrefix(titlePrefix);

      expect(page.items.map((item) => item.latestExecutionStatus)).toEqual([
        null,
      ]);
    },
  );

  concurrentTest(
    "with multiple executions, reports the newest execution's status, not an older one",
    async () => {
      const titlePrefix = `newest-status-${crypto.randomUUID()}`;
      const [workItem] = await seedWorkItems(apiClient, fixture(), [
        { title: titlePrefix },
      ]);
      if (!workItem) throw new Error("Expected the seeded work item to exist");

      // The suite's `TimeProvider` is fixed, so both executions share the same
      // `created_at` — this deliberately forces the collapse's tiebreaker
      // (`order by created_at desc, id desc`) to decide, proving it is really
      // applied rather than `created_at` happening to already be distinct.
      await recordExecutionResult(
        apiClient,
        fixture(),
        pipelineId(),
        workItem.id,
        "failed",
      );
      await recordExecutionResult(
        apiClient,
        fixture(),
        pipelineId(),
        workItem.id,
        "succeeded",
      );

      const page = await listByTitlePrefix(titlePrefix);

      expect(page.items.map((item) => item.latestExecutionStatus)).toEqual([
        "succeeded",
      ]);
    },
  );

  concurrentTest(
    "multiple executions on one work item do not inflate the page total",
    async () => {
      const titlePrefix = `no-fanout-status-${crypto.randomUUID()}`;
      const [withExecutions, withoutExecutions] = await seedWorkItems(
        apiClient,
        fixture(),
        [{ title: `${titlePrefix}-a` }, { title: `${titlePrefix}-b` }],
      );
      if (!withExecutions || !withoutExecutions) {
        throw new Error("Expected both seeded work items to exist");
      }

      // Three executions on the same work item — if the join fanned out, this
      // alone would inflate `total` past the true count of matching work items.
      await recordExecutionResult(
        apiClient,
        fixture(),
        pipelineId(),
        withExecutions.id,
        "failed",
      );
      await recordExecutionResult(
        apiClient,
        fixture(),
        pipelineId(),
        withExecutions.id,
        "failed",
      );
      await recordExecutionResult(
        apiClient,
        fixture(),
        pipelineId(),
        withExecutions.id,
        "succeeded",
      );

      const page = await listByTitlePrefix(titlePrefix);

      expect(page.items).toHaveLength(2);
      expect(page.pagination.total).toBe(2);
      expect(
        page.items
          .map((item) => ({
            title: item.title,
            latestExecutionStatus: item.latestExecutionStatus,
          }))
          .sort((left, right) => left.title.localeCompare(right.title)),
      ).toEqual([
        { title: `${titlePrefix}-a`, latestExecutionStatus: "succeeded" },
        { title: `${titlePrefix}-b`, latestExecutionStatus: null },
      ]);
    },
  );
});
