import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { WorkItemStatusSummaryContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// The statuses lookup is mocked as the project's API: it returns only the
// asked-for ids that are in `projectItems`, the way the endpoint leaves out
// deleted items and items in other projects.

let projectItems: WorkItemStatusSummaryContract[] = [];
const statusesGet = mock(({ query }: { query: { ids: string } }) =>
  Promise.resolve({
    data: query.ids
      .split(",")
      .flatMap((id) => projectItems.filter((item) => item.id === id)),
    error: null,
  }),
);
const projectsMock = mock(() => ({
  "work-item-statuses": { get: statusesGet },
}));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({ api: { projects: projectsMock } }),
}));

const { WorkItemDescription } = await import("./work-item-description");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");
const { workItemIdFromHref, workItemIdsInText } =
  await import("./work-item-links");

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const id = (suffix: string) => `01966a2c-9494-7db5-aa46-0f8f5cbbe${suffix}`;

const summary = (
  suffix: string,
  title: string,
  status: WorkItemStatusSummaryContract["status"],
): WorkItemStatusSummaryContract =>
  ({ id: id(suffix), title, status }) as WorkItemStatusSummaryContract;

const renderDescription = (
  description: string,
  knownWorkItems: WorkItemStatusSummaryContract[] = [],
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
    >
      <WorkItemDescription
        projectId={PROJECT_ID}
        description={description}
        knownWorkItems={knownWorkItems}
      />
    </ProjectRouteProvider>,
  );

describe("work item links", () => {
  test("match a path ending in /work-items/<uuid v7> on any host, absolute or relative", () => {
    const itemId = id("101");
    expect(
      workItemIdFromHref(`https://app.scarn.io/acme/web/work-items/${itemId}`),
    ).toBe(itemId);
    expect(
      workItemIdFromHref(`http://localhost:3000/a/b/work-items/${itemId}/`),
    ).toBe(itemId);
    expect(workItemIdFromHref(`/acme/web/work-items/${itemId}`)).toBe(itemId);
    expect(workItemIdFromHref(`work-items/${itemId.toUpperCase()}`)).toBe(
      itemId,
    );
    expect(
      workItemIdFromHref(
        `https://x.io/acme/web/work-items/${itemId}?tab=tasks`,
      ),
    ).toBe(itemId);
  });

  test("don't match other paths or ids that aren't UUID v7s", () => {
    expect(workItemIdFromHref(undefined)).toBeNull();
    expect(
      workItemIdFromHref("https://github.com/acme/web/issues/4"),
    ).toBeNull();
    expect(
      workItemIdFromHref(`/acme/web/work-items/${id("101")}/edit`),
    ).toBeNull();
    expect(
      workItemIdFromHref(
        "/acme/web/work-items/3f2b8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      ),
    ).toBeNull();
    expect(workItemIdFromHref("/acme/web/work-items/new")).toBeNull();
  });

  test("ids in text are found once each, in order", () => {
    expect(
      workItemIdsInText(
        `[a](/x/work-items/${id("102")}) [b](https://h/work-items/${id("101")}) [c](/work-items/${id("102")})`,
      ),
    ).toEqual([id("102"), id("101")]);
  });
});

describe("WorkItemDescription", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });
    projectItems = [];
    statusesGet.mockClear();
    projectsMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("a link to an item in the project shows its status and live title and opens in the same tab", async () => {
    projectItems = [summary("201", "Research the API", "running")];
    const view = renderDescription(
      `See [old title](https://other.host/acme/web/work-items/${id("201")}).`,
    );

    const link = await waitFor(() =>
      view.getByRole("link", { name: "Research the API" }),
    );
    expect(link.getAttribute("href")).toBe(
      `/tester/demo/work-items/${id("201")}`,
    );
    expect(link.getAttribute("target")).toBeNull();
    expect(view.getByRole("img", { name: "Running" })).toBeTruthy();
    expect(view.queryByText("old title")).toBeNull();
  });

  test("ids that don't resolve, are deleted or are in another project stay plain links, like any other link", async () => {
    projectItems = [summary("301", "In project", "ready")];
    const view = renderDescription(
      [
        `[Deleted](/acme/web/work-items/${id("302")})`,
        `[Elsewhere](https://app.scarn.io/other/proj/work-items/${id("303")})`,
        `[Docs](https://docs.example.com/guide)`,
        `[Here](work-items/${id("301")})`,
      ].join(" "),
    );

    await waitFor(() => view.getByRole("link", { name: "In project" }));
    for (const name of ["Deleted", "Elsewhere", "Docs"]) {
      const link = view.getByRole("link", { name });
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(
      view.getByRole("link", { name: "Elsewhere" }).getAttribute("href"),
    ).toBe(`https://app.scarn.io/other/proj/work-items/${id("303")}`);
    expect(view.getAllByRole("img")).toHaveLength(1);
  });

  test("looks up every linked item in one project-scoped request", async () => {
    projectItems = [
      summary("401", "One", "ready"),
      summary("402", "Two", "blocked"),
    ];
    const view = renderDescription(
      `[a](/x/work-items/${id("401")}) and [b](/x/work-items/${id("402")}) and [a again](/x/work-items/${id("401")})`,
    );

    await waitFor(() => view.getByRole("link", { name: "Two" }));
    expect(view.getAllByRole("link", { name: "One" })).toHaveLength(2);
    expect(statusesGet).toHaveBeenCalledTimes(1);
    expect(projectsMock).toHaveBeenCalledWith({ projectId: PROJECT_ID });
    expect(statusesGet).toHaveBeenCalledWith({
      query: { ids: `${id("401")},${id("402")}` },
    });
  });

  test("items already loaded, such as the children, need no lookup", async () => {
    const view = renderDescription(
      `[child](/x/work-items/${id("501")}) and [other](/x/work-items/${id("502")})`,
      [summary("501", "Loaded child", "closed")],
    );

    expect(view.getByRole("link", { name: "Loaded child" })).toBeTruthy();
    expect(view.getByRole("img", { name: "Closed" })).toBeTruthy();
    await waitFor(() => {
      expect(statusesGet).toHaveBeenCalledTimes(1);
    });
    expect(statusesGet).toHaveBeenCalledWith({ query: { ids: id("502") } });
  });

  test("with every linked item loaded, or no work item links, makes no request", async () => {
    renderDescription(`[child](/x/work-items/${id("601")})`, [
      summary("601", "Loaded", "ready"),
    ]);
    renderDescription("Just [docs](https://docs.example.com) and text.");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(statusesGet).not.toHaveBeenCalled();
  });
});
