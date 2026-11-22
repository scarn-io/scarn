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
 * `labels=a,b` on `GET /projects/:projectId/work-items` (an item must carry
 * every label) and `GET /projects/:projectId/work-item-labels` (the project's
 * distinct labels).
 */
describe("project work items labels", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-26T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  let project: ListingProject | undefined;

  beforeAll(async () => {
    project = await createListingProject(apiClient, "labels");
    await seedWorkItems(apiClient, project, [
      { title: "bug ui", labels: ["bug", "ui"] },
      { title: "bug", labels: ["bug"] },
      { title: "ui", labels: ["ui"] },
      { title: "Bug capital", labels: ["Bug"] },
      { title: "none" },
    ]);
  });

  const fixture = (): ListingProject => {
    if (!project) throw new Error("Expected the labels fixture to be seeded");
    return project;
  };

  const titlesWithLabels = async (labels: string): Promise<string[]> => {
    const page = await unwrapAsync(
      apiClient.api
        .projects({ projectId: fixture().projectId })
        ["work-items"].get({
          query: { labels },
          headers: { ...fixture().authHeaders },
        }),
    );
    return page.items.map((item) => item.title).sort();
  };

  concurrentTest("an item must carry every requested label", async () => {
    expect(await titlesWithLabels("bug,ui")).toEqual(["bug ui"]);
    expect(await titlesWithLabels("bug")).toEqual(["bug", "bug ui"]);
  });

  concurrentTest("label matching is case-sensitive", async () => {
    expect(await titlesWithLabels("Bug")).toEqual(["Bug capital"]);
  });

  concurrentTest("blank entries are ignored", async () => {
    expect(await titlesWithLabels(" ui , ,")).toEqual(["bug ui", "ui"]);
    expect(await titlesWithLabels(",")).toHaveLength(5);
  });

  concurrentTest("a label nobody has matches nothing", async () => {
    expect(await titlesWithLabels("bug,missing")).toEqual([]);
  });

  concurrentTest("lists the project's distinct labels, sorted", async () => {
    const labels = await unwrapAsync(
      apiClient.api
        .projects({ projectId: fixture().projectId })
        ["work-item-labels"].get({ headers: { ...fixture().authHeaders } }),
    );

    expect(labels).toEqual(["Bug", "bug", "ui"]);
  });

  concurrentTest("a project with no labels lists none", async () => {
    const empty = await createListingProject(apiClient, "labels-empty");
    await seedWorkItems(apiClient, empty, [{ title: "plain" }]);

    const labels = await unwrapAsync(
      apiClient.api
        .projects({ projectId: empty.projectId })
        ["work-item-labels"].get({ headers: { ...empty.authHeaders } }),
    );

    expect(labels).toEqual([]);
  });

  concurrentTest(
    "a non-member cannot list a private project's labels",
    async () => {
      const other = await createListingProject(apiClient, "labels-other");

      const { data, error } = await apiClient.api
        .projects({ projectId: fixture().projectId })
        ["work-item-labels"].get({ headers: { ...other.authHeaders } });

      expect(data).toBeNull();
      expect([403, 404]).toContain(error?.status ?? 0);
    },
  );
});
