import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * Offset pagination for `GET /projects/:projectId/work-items`.
 *
 * The interesting cases are the two the `COUNT(*) OVER ()` window function
 * cannot answer on its own: an out-of-range page still has to report the real
 * total, and paging has to be stable when every ordering column ties.
 */
describe("project work items pagination", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const listPage = async (
    project: ListingProject,
    query: { page?: number; pageSize?: number },
  ) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        ["work-items"].get({
          query,
          headers: { ...project.authHeaders },
        }),
    );

  /** `count` items whose ordering columns all tie, so only `id` separates them. */
  const seedTiedWorkItems = async (project: ListingProject, count: number) =>
    await seedWorkItems(
      apiClient,
      project,
      Array.from({ length: count }, (_unused, index) => ({
        title: `Tied work item ${String(index)}`,
        sourceUpdatedAt: "2026-04-24T10:00:00.000Z",
      })),
    );

  concurrentTest(
    "page 1 and page 2 are disjoint and both report the full total",
    async () => {
      const project = await createListingProject(apiClient, "pagination-pages");
      await seedTiedWorkItems(project, 5);

      const first = await listPage(project, { page: 1, pageSize: 2 });
      const second = await listPage(project, { page: 2, pageSize: 2 });

      expect(first.pagination).toEqual({ page: 1, pageSize: 2, total: 5 });
      expect(second.pagination).toEqual({ page: 2, pageSize: 2, total: 5 });

      const firstIds = first.items.map((item) => item.id);
      const secondIds = second.items.map((item) => item.id);
      expect(firstIds).toHaveLength(2);
      expect(secondIds).toHaveLength(2);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    },
  );

  concurrentTest(
    "a full page returns exactly pageSize items and the last page the remainder",
    async () => {
      const project = await createListingProject(
        apiClient,
        "pagination-boundary",
      );
      await seedTiedWorkItems(project, 5);

      const full = await listPage(project, { page: 1, pageSize: 5 });
      const partial = await listPage(project, { page: 3, pageSize: 2 });

      expect(full.items).toHaveLength(5);
      expect(full.pagination).toEqual({ page: 1, pageSize: 5, total: 5 });
      expect(partial.items).toHaveLength(1);
      expect(partial.pagination).toEqual({ page: 3, pageSize: 2, total: 5 });
    },
  );

  concurrentTest(
    "an out-of-range page returns no items but the real non-zero total",
    async () => {
      const project = await createListingProject(
        apiClient,
        "pagination-out-of-range",
      );
      await seedTiedWorkItems(project, 3);

      const far = await listPage(project, { page: 999, pageSize: 25 });
      const justPast = await listPage(project, { page: 3, pageSize: 2 });

      expect(far.items).toEqual([]);
      // The requested page is echoed back, and `total` still lets the UI
      // navigate back to a page that exists.
      expect(far.pagination).toEqual({ page: 999, pageSize: 25, total: 3 });
      expect(justPast.items).toEqual([]);
      expect(justPast.pagination).toEqual({ page: 3, pageSize: 2, total: 3 });
    },
  );

  concurrentTest(
    "page 1 of an empty project reports a zero total",
    async () => {
      const project = await createListingProject(apiClient, "pagination-empty");

      const page = await listPage(project, { page: 1, pageSize: 25 });

      expect(page.items).toEqual([]);
      expect(page.pagination).toEqual({ page: 1, pageSize: 25, total: 0 });
    },
  );

  concurrentTest(
    "paging through fully tied items yields every item exactly once",
    async () => {
      const project = await createListingProject(
        apiClient,
        "pagination-stable",
      );
      const seeded = await seedTiedWorkItems(project, 5);

      const pageSize = 2;
      const collected: string[] = [];
      for (const page of [1, 2, 3]) {
        const result = await listPage(project, { page, pageSize });
        expect(result.pagination.total).toBe(5);
        collected.push(...result.items.map((item) => item.id));
      }

      // No duplicates and no omissions: the concatenation is a permutation of
      // the seeded ids...
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual(
        seeded.map((item) => item.id).sort(),
      );
      // ...and, because every other ordering column ties, the `id DESC`
      // tiebreaker fixes the exact order across the page boundaries.
      expect(collected).toEqual(
        seeded
          .map((item) => item.id)
          .sort()
          .reverse(),
      );
    },
  );
});
