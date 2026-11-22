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
 * Text search for `GET /projects/:projectId/work-items` — an `ILIKE '%q%'`
 * OR-group over title, description, platformKey, platformId, url, and the
 * (cast) platform enum. Each fixture project is seeded once and shared
 * read-only by the concurrent cases in its block.
 */
describe("project work items text search", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const searchTitles = async (
    project: ListingProject,
    q: string,
  ): Promise<string[]> => {
    const page = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.projectId })
        ["work-items"].get({
          query: { q, page: 1, pageSize: 25 },
          headers: { ...project.authHeaders },
        }),
    );
    return page.items.map((item) => item.title).sort();
  };

  describe("searchable fields", () => {
    let project: ListingProject | undefined;

    beforeAll(async () => {
      project = await createListingProject(apiClient, "search-fields");
      await seedWorkItems(apiClient, project, [
        {
          title: "Carries titletoken",
          description: "Neutral body one",
          platform: "github",
        },
        {
          title: "Neutral heading two",
          description: "Body carries desctoken inside",
          platform: "github",
        },
        {
          title: "Neutral heading three",
          description: "Neutral body three",
          platformKey: `keytoken-${crypto.randomUUID()}`,
          platform: "github",
        },
        {
          title: "Neutral heading four",
          description: "Neutral body four",
          platformId: `idtoken-${crypto.randomUUID()}`,
          platform: "github",
        },
        {
          title: "Neutral heading five",
          description: "Neutral body five",
          platform: "jira",
        },
        {
          title: "Neutral heading six",
          description: "Neutral body six",
          url: "https://github.com/example/repo/issues/urltoken",
          platform: "github",
        },
      ]);
    });

    const fixture = (): ListingProject => {
      if (!project) throw new Error("Expected the search fixture to be seeded");
      return project;
    };

    concurrentTest("matches on title", async () => {
      expect(await searchTitles(fixture(), "titletoken")).toEqual([
        "Carries titletoken",
      ]);
    });

    concurrentTest("matches on description", async () => {
      expect(await searchTitles(fixture(), "desctoken")).toEqual([
        "Neutral heading two",
      ]);
    });

    concurrentTest("matches on platformKey", async () => {
      expect(await searchTitles(fixture(), "keytoken")).toEqual([
        "Neutral heading three",
      ]);
    });

    concurrentTest("matches on platformId", async () => {
      expect(await searchTitles(fixture(), "idtoken")).toEqual([
        "Neutral heading four",
      ]);
    });

    concurrentTest("matches on the platform enum", async () => {
      expect(await searchTitles(fixture(), "jira")).toEqual([
        "Neutral heading five",
      ]);
    });

    concurrentTest("matches on url", async () => {
      // Lets the CLI picker's free-text fallback resolve a pasted ticket URL
      // to an already-ingested item instead of always creating a new one.
      expect(await searchTitles(fixture(), "urltoken")).toEqual([
        "Neutral heading six",
      ]);
    });

    concurrentTest("is case-insensitive", async () => {
      expect(await searchTitles(fixture(), "TITLETOKEN")).toEqual([
        "Carries titletoken",
      ]);
      expect(await searchTitles(fixture(), "JiRa")).toEqual([
        "Neutral heading five",
      ]);
    });

    concurrentTest("returns nothing when no field matches", async () => {
      expect(await searchTitles(fixture(), "absenttoken")).toEqual([]);
    });

    concurrentTest("an empty q is not a filter", async () => {
      const page = await unwrapAsync(
        apiClient.api
          .projects({ projectId: fixture().projectId })
          ["work-items"].get({
            query: { q: "", page: 1, pageSize: 25 },
            headers: { ...fixture().authHeaders },
          }),
      );
      expect(page.pagination.total).toBe(6);
    });

    concurrentTest("a whitespace-only q is not a filter", async () => {
      const page = await unwrapAsync(
        apiClient.api
          .projects({ projectId: fixture().projectId })
          ["work-items"].get({
            query: { q: "   ", page: 1, pageSize: 25 },
            headers: { ...fixture().authHeaders },
          }),
      );
      expect(page.pagination.total).toBe(6);
    });
  });

  describe("LIKE metacharacters", () => {
    let project: ListingProject | undefined;

    beforeAll(async () => {
      project = await createListingProject(apiClient, "search-wildcards");
      await seedWorkItems(apiClient, project, [
        { title: "Discount 50% off" },
        { title: "Discount 5011 off" },
        { title: "snake_case token" },
        { title: "snakeXcase token" },
        { title: "path\\to\\thing" },
      ]);
    });

    const fixture = (): ListingProject => {
      if (!project) throw new Error("Expected the search fixture to be seeded");
      return project;
    };

    concurrentTest("treats % as a literal", async () => {
      // Unescaped, `%50%%` would also match "Discount 5011 off".
      expect(await searchTitles(fixture(), "50%")).toEqual([
        "Discount 50% off",
      ]);
    });

    concurrentTest("treats _ as a literal", async () => {
      // Unescaped, `%snake_case%` would also match "snakeXcase token".
      expect(await searchTitles(fixture(), "snake_case")).toEqual([
        "snake_case token",
      ]);
    });

    concurrentTest("treats a backslash as a literal", async () => {
      // Unescaped, `%path\to%` would mean "patht o" — Postgres' default LIKE
      // escape character swallows the `t` — and match nothing.
      expect(await searchTitles(fixture(), "path\\to")).toEqual([
        "path\\to\\thing",
      ]);
    });
  });
});
