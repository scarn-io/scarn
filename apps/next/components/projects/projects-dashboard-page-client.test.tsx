import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";

// ─── Router mock ────────────────────────────────────────────────────────────────

const pushMock = mock(() => {});
void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// ─── API client mock ────────────────────────────────────────────────────────────

type ProjectsGetResult = Promise<{
  data: unknown[];
  error: null;
}>;

let projectsGetMock = mock((): ProjectsGetResult =>
  Promise.resolve({ data: [], error: null }),
);
void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: { projects: { get: projectsGetMock } },
  }),
}));

const { ProjectsDashboardPageClient } =
  await import("./projects-dashboard-page-client");

// ─── DOM setup helper ───────────────────────────────────────────────────────────

function setupDom() {
  installDom({ url: "https://app.scarn.io/" });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener() {},
        addListener() {},
        dispatchEvent() {
          return false;
        },
        matches: false,
        media: query,
        onchange: null,
        removeEventListener() {},
        removeListener() {},
      }) as MediaQueryList,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("ProjectsDashboardPageClient", () => {
  beforeEach(() => {
    setupDom();
    pushMock.mockClear();
    projectsGetMock = mock((): ProjectsGetResult =>
      Promise.resolve({ data: [], error: null }),
    );
  });

  afterEach(() => {
    cleanup();
  });

  test("a zero-projects user sees an empty-state with a demo-project link, and is never redirected (#154)", async () => {
    const view = render(
      <ProjectsDashboardPageClient username="alice" showDemoLink={true} />,
    );

    await waitFor(() => {
      expect(view.getByText("No projects yet")).toBeTruthy();
    });

    expect(pushMock).not.toHaveBeenCalled();

    const demoLink = view.getByRole("link", { name: "See the demo project" });
    expect(demoLink.getAttribute("href")).toBe("/scarn/demo/work-items");
  });

  test("the empty state has no demo-project link when the deployment has not enabled it", async () => {
    const view = render(
      <ProjectsDashboardPageClient username="alice" showDemoLink={false} />,
    );

    await waitFor(() => {
      expect(view.getByText("No projects yet")).toBeTruthy();
    });

    expect(
      view.queryByRole("link", { name: "See the demo project" }),
    ).toBeNull();
  });

  test("a zero-projects user still has the primary create-project CTA available", async () => {
    const view = render(
      <ProjectsDashboardPageClient username="alice" showDemoLink={false} />,
    );

    await waitFor(() => {
      expect(view.getByText("No projects yet")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: "New project" }));
    expect(pushMock).toHaveBeenCalledWith("/projects/new");
  });

  test("the empty state offers its own create-project action and the CLI command", async () => {
    const view = render(
      <ProjectsDashboardPageClient username="alice" showDemoLink={false} />,
    );

    await waitFor(() => {
      expect(view.getByText("No projects yet")).toBeTruthy();
    });

    const createLink = view.getByRole("link", { name: "Create a project" });
    expect(createLink.getAttribute("href")).toBe("/projects/new");
    expect(view.getByText("npm i -g @scarn/cli && scarn init")).toBeTruthy();
    expect(
      view.getByRole("button", {
        name: "Copy command: npm i -g @scarn/cli && scarn init",
      }),
    ).toBeTruthy();
  });

  test("a user with >=1 project sees their normal project list, with no empty-state or demo link", async () => {
    projectsGetMock = mock((): ProjectsGetResult =>
      Promise.resolve({
        data: [
          {
            id: "01966a2c-9494-7db5-aa46-0f8f5cbbe000",
            name: "My Project",
            slug: "my-project",
            description: null,
            gitUrl: "git@github.com:alice/my-project.git",
            ownerUsername: "alice",
            memberships: [{ userId: "u1" }],
            createdAt: new Date().toISOString(),
          },
        ],
        error: null,
      }),
    );

    const view = render(
      <ProjectsDashboardPageClient username="alice" showDemoLink={false} />,
    );

    await waitFor(() => {
      expect(view.getByText("My Project")).toBeTruthy();
    });

    expect(view.queryByText("No projects yet")).toBeNull();
    expect(
      view.queryByRole("link", { name: "See the demo project" }),
    ).toBeNull();
    expect(view.queryByRole("link", { name: "Create a project" })).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
