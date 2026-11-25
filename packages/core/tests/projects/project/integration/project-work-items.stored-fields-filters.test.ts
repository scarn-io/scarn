import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import fieldsFixtureJson from "tests/work-items/work-item/fixtures/fields.json";
import {
  createListingProject,
  seedWorkItems,
  type ListingProject,
} from "./work-item-listing-test-support";

const fieldsFixtures = fieldsFixtureJson.map((fixture) => ({
  title: fixture.title,
  fields: anyJsonObjectSchema.parse(fixture.fields),
}));

/**
 * The `fields ->> key` listing filters and field options against the
 * `work_items.fields` stored-reader fixture, so the SQL reads of the column
 * stay in step with the shapes the reader accepts.
 */
describe("project work items field filters on the stored fields fixture", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  let project: ListingProject | undefined;

  beforeAll(async () => {
    project = await createListingProject(apiClient, "stored-fields");
    await seedWorkItems(
      apiClient,
      project,
      fieldsFixtures.map((fixture) => ({
        title: fixture.title,
        fields: fixture.fields,
      })),
    );
  });

  const seeded = (): ListingProject => {
    if (!project) throw new Error("Expected the fields fixture to be seeded");
    return project;
  };

  const filterTitles = async (
    key: string,
    value: string,
  ): Promise<string[]> => {
    const response = await app.handle(
      new Request(
        `http://localhost/api/projects/${seeded().projectId}/work-items?f.${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
        { headers: { ...seeded().authHeaders } },
      ),
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as { items: { title: string }[] };
    return page.items.map((item) => item.title).sort();
  };

  concurrentTest("filters on a string field", async () => {
    expect(await filterTitles("state", "open")).toEqual([
      "fixture github issue",
    ]);
  });

  concurrentTest("filters on a field several sources write", async () => {
    expect(await filterTitles("reporter", "Example Reporter")).toEqual(
      ["fixture bitbucket issue", "fixture jira issue"].sort(),
    );
  });

  concurrentTest("filters on number and boolean fields as text", async () => {
    expect(await filterTitles("number", "42")).toEqual([
      "fixture github issue",
    ]);
    expect(await filterTitles("customfield_10030", "1.5")).toEqual([
      "fixture jira issue",
    ]);
    expect(await filterTitles("customfield_10040", "true")).toEqual([
      "fixture jira issue",
    ]);
  });

  concurrentTest("does not match object or array fields", async () => {
    expect(await filterTitles("customfield_10010", "Example option")).toEqual(
      [],
    );
    expect(await filterTitles("customfield_10020", "one")).toEqual([]);
  });

  concurrentTest("reads every fixture's fields back unchanged", async () => {
    const response = await app.handle(
      new Request(
        `http://localhost/api/projects/${seeded().projectId}/work-items`,
        { headers: { ...seeded().authHeaders } },
      ),
    );
    const page = (await response.json()) as {
      items: { title: string; fields: unknown }[];
    };
    const fieldsByTitle = new Map(
      page.items.map((item) => [item.title, item.fields]),
    );
    for (const fixture of fieldsFixtures) {
      expect(fieldsByTitle.get(fixture.title)).toEqual(fixture.fields);
    }
  });

  concurrentTest("lists the fixture's scalar fields as options", async () => {
    const options = await unwrapAsync(
      apiClient.api
        .projects({ projectId: seeded().projectId })
        ["work-item-field-options"].get({
          headers: { ...seeded().authHeaders },
        }),
    );
    const keys = new Set(options.map((option) => option.key));
    expect(keys.has("state")).toBe(true);
    expect(keys.has("customfield_10010")).toBe(false);
    expect(keys.has("customfield_10020")).toBe(false);
  });
});
