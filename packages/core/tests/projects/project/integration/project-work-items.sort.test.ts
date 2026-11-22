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
 * The `created`/`updated` sort axes for `GET /projects/:projectId/work-items`
 * (`docs/plans/work-item-sort.md`, Phase 1). The fixture deliberately gives
 * every item a creation order that disagrees with its effective-updated
 * order, so a test asserting on one axis cannot pass by accident from the
 * other axis's ordering.
 *
 * Creation order (and so `created` order): Item A, Item B, Item C.
 * Effective-updated order (`sourceUpdatedAt` desc): Item B, Item A, Item C.
 */
describe("project work items created/updated sort", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  let project: ListingProject | undefined;

  beforeAll(async () => {
    project = await createListingProject(apiClient, "sort-axis");

    await seedWorkItems(apiClient, project, [
      { title: "Item A", sourceUpdatedAt: "2026-04-20T10:00:00.000Z" },
      { title: "Item B", sourceUpdatedAt: "2026-04-22T10:00:00.000Z" },
      { title: "Item C", sourceUpdatedAt: "2026-04-18T10:00:00.000Z" },
    ]);
  });

  const fixture = (): ListingProject => {
    if (!project)
      throw new Error("Expected the sort-axis fixture to be seeded");
    return project;
  };

  const listWith = async (sort: string | undefined) =>
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: fixture().projectId })
        ["work-items"].get({
          query: {
            page: 1,
            pageSize: 25,
            ...(sort !== undefined ? { sort } : {}),
          },
          headers: { ...fixture().authHeaders },
        }),
    );

  concurrentTest("created-desc orders by creation newest-first", async () => {
    const page = await listWith("created-desc");

    expect(page.items.map((item) => item.title)).toEqual([
      "Item C",
      "Item B",
      "Item A",
    ]);
  });

  concurrentTest("created-asc reverses creation order", async () => {
    const page = await listWith("created-asc");

    expect(page.items.map((item) => item.title)).toEqual([
      "Item A",
      "Item B",
      "Item C",
    ]);
  });

  concurrentTest(
    "updated-asc reverses the existing default order",
    async () => {
      const page = await listWith("updated-asc");

      expect(page.items.map((item) => item.title)).toEqual([
        "Item C",
        "Item A",
        "Item B",
      ]);
    },
  );

  concurrentTest(
    "updated-desc matches the no-sort-param default byte-for-byte (decision 4)",
    async () => {
      const withoutSort = await listWith(undefined);
      const withUpdatedDesc = await listWith("updated-desc");

      expect(withoutSort.items.map((item) => item.title)).toEqual([
        "Item B",
        "Item A",
        "Item C",
      ]);
      expect(withUpdatedDesc).toEqual(withoutSort);
    },
  );

  concurrentTest(
    "an unrecognized sort token drops silently and falls back to the default order",
    async () => {
      const withoutSort = await listWith(undefined);
      const withBogusSort = await listWith("bogus");

      expect(withBogusSort).toEqual(withoutSort);
    },
  );
});
