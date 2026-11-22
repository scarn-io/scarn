import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * `updatedAfter` / `updatedBefore` for `GET /projects/:projectId/work-items` —
 * a half-open window over `coalesce(source_updated_at, updated_at)`.
 *
 * The clock is fixed, which is the whole point: relative bounds are resolved
 * server-side against the `TimeProvider`, so `24h` and `7d` are pinned here
 * rather than drifting with the wall clock.
 */
describe("project work items updated filter", () => {
  const NOW = new Date("2026-04-26T12:00:00.000Z");

  const app = createApp(
    createAppContext({ timeProvider: fixedTimeProvider(NOW) }),
  );
  const apiClient = createScarnTreaty(app);

  const filterTitles = async (
    project: ListingProject,
    bounds: { updatedAfter?: string; updatedBefore?: string },
  ): Promise<string[]> => {
    const page = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        ["work-items"].get({
          query: { ...bounds, page: 1, pageSize: 25 },
          headers: { ...project.authHeaders },
        }),
    );
    return page.items.map((item) => item.title).sort();
  };

  /**
   * Every item carries an explicit `sourceUpdatedAt`, so the window under test
   * is the only thing deciding membership.
   */
  describe("bounds over an explicit source timestamp", () => {
    let project: ListingProject | undefined;

    beforeAll(async () => {
      project = await createListingProject(apiClient, "updated-filter");
      await seedWorkItems(apiClient, project, [
        { title: "one hour ago", sourceUpdatedAt: "2026-04-26T11:00:00.000Z" },
        {
          title: "three days ago",
          sourceUpdatedAt: "2026-04-23T12:00:00.000Z",
        },
        { title: "ten days ago", sourceUpdatedAt: "2026-04-16T12:00:00.000Z" },
        {
          title: "sixty days ago",
          sourceUpdatedAt: "2026-02-25T12:00:00.000Z",
        },
      ]);
    });

    const fixture = (): ListingProject => {
      if (!project)
        throw new Error("Expected the updated fixture to be seeded");
      return project;
    };

    concurrentTest("a relative `after` keeps only the hot end", async () => {
      expect(await filterTitles(fixture(), { updatedAfter: "24h" })).toEqual([
        "one hour ago",
      ]);
      expect(await filterTitles(fixture(), { updatedAfter: "7d" })).toEqual([
        "one hour ago",
        "three days ago",
      ]);
    });

    concurrentTest("a relative `before` keeps only the cold end", async () => {
      expect(await filterTitles(fixture(), { updatedBefore: "30d" })).toEqual([
        "sixty days ago",
      ]);
      expect(await filterTitles(fixture(), { updatedBefore: "90d" })).toEqual(
        [],
      );
    });

    concurrentTest("both bounds compose into a range", async () => {
      expect(
        await filterTitles(fixture(), {
          updatedAfter: "30d",
          updatedBefore: "7d",
        }),
      ).toEqual(["ten days ago"]);
    });

    concurrentTest("absolute dates bound the same window", async () => {
      expect(
        await filterTitles(fixture(), {
          updatedAfter: "2026-04-16",
          updatedBefore: "2026-04-26",
        }),
      ).toEqual(["ten days ago", "three days ago"]);
    });

    concurrentTest(
      "an absolute `after` is inclusive and `before` exclusive",
      async () => {
        // The `ten days ago` item sits at 2026-04-16T12:00Z, so a bound on its
        // own day includes it from the start of the day and excludes it from
        // the next — the half-open shape that lets two ranges tile without
        // double-counting.
        expect(
          await filterTitles(fixture(), { updatedAfter: "2026-04-16" }),
        ).toEqual(["one hour ago", "ten days ago", "three days ago"]);
        expect(
          await filterTitles(fixture(), { updatedBefore: "2026-04-16" }),
        ).toEqual(["sixty days ago"]);
      },
    );

    concurrentTest("an unreadable bound is ignored, not rejected", async () => {
      expect(
        await filterTitles(fixture(), { updatedAfter: "last tuesday" }),
      ).toHaveLength(4);
      // Matches the `<N>[h|d] | YYYY-MM-DD` shape but names a day that does not
      // exist, which would be an uncastable literal if it reached Postgres.
      expect(
        await filterTitles(fixture(), { updatedAfter: "2026-02-31" }),
      ).toHaveLength(4);
      expect(
        await filterTitles(fixture(), { updatedBefore: "7 days" }),
      ).toHaveLength(4);
    });
  });

  /**
   * The `coalesce` half of the predicate, in its own project so the
   * insert-time `updated_at` of the source-less item cannot perturb the
   * relative-window assertions above.
   *
   * The boundary is far enough in the past that the source-less item's
   * `updated_at` — set by the database at insert — is unambiguously after it.
   */
  describe("items with no source timestamp", () => {
    let project: ListingProject | undefined;

    beforeAll(async () => {
      project = await createListingProject(
        apiClient,
        "updated-filter-fallback",
      );
      await seedWorkItems(apiClient, project, [
        { title: "synced only", sourceUpdatedAt: null },
        {
          title: "ancient source",
          sourceUpdatedAt: "2019-01-01T00:00:00.000Z",
        },
      ]);
    });

    const fixture = (): ListingProject => {
      if (!project) {
        throw new Error("Expected the fallback fixture to be seeded");
      }
      return project;
    };

    concurrentTest("fall back to the sync timestamp", async () => {
      // A bare `source_updated_at` predicate would compare NULL and drop this
      // item, even though the unfiltered list sorts it by `updated_at`.
      expect(
        await filterTitles(fixture(), { updatedAfter: "2020-01-01" }),
      ).toEqual(["synced only"]);
      expect(
        await filterTitles(fixture(), { updatedBefore: "2020-01-01" }),
      ).toEqual(["ancient source"]);
    });
  });
});
