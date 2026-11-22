import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider } from "tests/utils";
import type { PaginatedWorkItemsContract } from "@/work-items/work-item/contracts/work-item-contracts";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

/**
 * Dynamic `fields` filtering — `f.<encodeURIComponent(key)>=<value>`, AND-ed,
 * compiled to `fields ->> key = value`.
 *
 * Driven through `app.handle(new Request(...))` so the literal query string
 * under test is explicit: the filter params are dynamic, so their percent
 * encoding is part of the contract and must not be re-encoded by a client.
 */
describe("project work items field filters", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const QUOTED_KEY = `it's "quoted"`;

  let project: ListingProject | undefined;

  beforeAll(async () => {
    project = await createListingProject(apiClient, "field-filters");
    await seedWorkItems(apiClient, project, [
      { title: "prod gold", fields: { env: "prod", tier: "gold" } },
      { title: "prod silver", fields: { env: "prod", tier: "silver" } },
      { title: "dev gold", fields: { env: "dev", tier: "gold" } },
      { title: "prod no tier", fields: { env: "prod" } },
      { title: "prod array tier", fields: { env: "prod", tier: ["gold"] } },
      {
        title: "prod object tier",
        fields: { env: "prod", tier: { value: "gold" } },
      },
      { title: "prod null tier", fields: { env: "prod", tier: null } },
      {
        title: "scalar coercions",
        fields: { count: 5, flag: true, [QUOTED_KEY]: "yes" },
      },
    ]);
  });

  const fixture = (): ListingProject => {
    if (!project) throw new Error("Expected the filter fixture to be seeded");
    return project;
  };

  /**
   * `f.` params are built by hand rather than with `URLSearchParams`, which
   * would double-encode the already-encoded key segment.
   */
  const listWithRawQuery = async (
    query: string,
  ): Promise<PaginatedWorkItemsContract> => {
    const response = await app.handle(
      new Request(
        `http://localhost/api/projects/${fixture().projectId}/work-items?${query}`,
        { headers: { ...fixture().authHeaders } },
      ),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as PaginatedWorkItemsContract;
  };

  const filterTitles = async (
    filters: { key: string; value: string }[],
  ): Promise<string[]> => {
    const query = filters
      .map(
        (filter) =>
          `f.${encodeURIComponent(filter.key)}=${encodeURIComponent(filter.value)}`,
      )
      .join("&");
    const page = await listWithRawQuery(query);
    return page.items.map((item) => item.title).sort();
  };

  concurrentTest("ANDs two filters together", async () => {
    expect(
      await filterTitles([
        { key: "env", value: "prod" },
        { key: "tier", value: "gold" },
      ]),
    ).toEqual(["prod gold"]);
  });

  concurrentTest("a single filter matches across values", async () => {
    expect(await filterTitles([{ key: "tier", value: "gold" }])).toEqual([
      "dev gold",
      "prod gold",
    ]);
  });

  concurrentTest("excludes rows missing the filtered key", async () => {
    const titles = await filterTitles([{ key: "tier", value: "gold" }]);
    expect(titles).not.toContain("prod no tier");
    expect(titles).not.toContain("scalar coercions");
  });

  concurrentTest(
    "excludes rows whose value is an array, object, or JSON null",
    async () => {
      const titles = await filterTitles([{ key: "tier", value: "gold" }]);
      expect(titles).not.toContain("prod array tier");
      expect(titles).not.toContain("prod object tier");
      expect(titles).not.toContain("prod null tier");
    },
  );

  concurrentTest("matches a JSONB number against its text form", async () => {
    expect(await filterTitles([{ key: "count", value: "5" }])).toEqual([
      "scalar coercions",
    ]);
  });

  concurrentTest("matches a JSONB boolean against its text form", async () => {
    expect(await filterTitles([{ key: "flag", value: "true" }])).toEqual([
      "scalar coercions",
    ]);
    expect(await filterTitles([{ key: "flag", value: "false" }])).toEqual([]);
  });

  concurrentTest(
    "handles a key containing quotes and apostrophes",
    async () => {
      expect(await filterTitles([{ key: QUOTED_KEY, value: "yes" }])).toEqual([
        "scalar coercions",
      ]);
    },
  );

  concurrentTest("skips a filter whose key is not valid encoding", async () => {
    // `%ZZ` cannot be decoded; the filter is dropped rather than 422-ing.
    const page = await listWithRawQuery("f.%ZZ=prod");
    expect(page.pagination.total).toBe(8);
  });

  concurrentTest("skips a filter with a blank value", async () => {
    const page = await listWithRawQuery("f.env=");
    expect(page.pagination.total).toBe(8);
  });

  concurrentTest("skips a filter with a blank key", async () => {
    const page = await listWithRawQuery("f.=prod");
    expect(page.pagination.total).toBe(8);
  });

  concurrentTest("a non-matching filter yields an empty page", async () => {
    const page = await listWithRawQuery("f.env=staging");
    expect(page.items).toEqual([]);
    expect(page.pagination).toEqual({ page: 1, pageSize: 25, total: 0 });
  });
});
