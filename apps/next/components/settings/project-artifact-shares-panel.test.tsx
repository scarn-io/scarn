import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  parseUuidV7,
  type ProjectArtifactShareContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const dom = installDom();
const clipboardWrites: string[] = [];

Object.defineProperty(dom.window.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (text: string) => {
      clipboardWrites.push(text);
      return Promise.resolve();
    },
  },
});

const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
const SHARE_URL = "https://content.example.test/s/sh1.abc/";

type ApiResult = { data: unknown; error: unknown };

let revokeResult: ApiResult = { data: {}, error: null };
const revokeCalls: string[] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        "artifact-bundles": (params: { bundleId: string }) => ({
          share: {
            delete: () => {
              revokeCalls.push(params.bundleId);
              return Promise.resolve(revokeResult);
            },
          },
        }),
      }),
    },
  }),
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ProjectArtifactSharesPanel } =
  await import("./project-artifact-shares-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

function buildShare(
  overrides: Partial<ProjectArtifactShareContract> = {},
): ProjectArtifactShareContract {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
    bundleId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901"),
    bundleName: "playwright-report",
    taskRunId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699"),
    status: "shared",
    url: SHARE_URL,
    createdVia: "person",
    createdAt: "2026-11-20T12:00:00.000Z",
    expiresAt: "2026-12-20T12:00:00.000Z",
    ...overrides,
  };
}

const sharedShare = buildShare();
const expiredShare = buildShare({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
  bundleId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa902"),
  bundleName: "old-report",
  status: "expired",
  url: null,
  createdVia: "step",
});
const unavailableShare = buildShare({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa803"),
  bundleId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa903"),
  bundleName: "screenshots",
  status: "unavailable",
  url: null,
});

const renderPanel = (
  shares: ProjectArtifactShareContract[],
  permissions: string[] = ["executions:write"],
  initialHasMore = false,
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={projectId}
      isMember={true}
      permissions={permissions}
    >
      <ProjectArtifactSharesPanel
        projectId={projectId}
        initialShares={shares}
        initialHasMore={initialHasMore}
      />
    </ProjectRouteProvider>,
  );

describe("ProjectArtifactSharesPanel", () => {
  beforeEach(() => {
    revokeCalls.length = 0;
    clipboardWrites.length = 0;
    revokeResult = { data: {}, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  test("renders a row per share with its status, origin and bundle link", () => {
    const view = renderPanel([sharedShare, expiredShare, unavailableShare]);

    expect(view.getByText("Shared")).toBeTruthy();
    expect(view.getByText("Expired")).toBeTruthy();
    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.getAllByText(/^Shared by a person/)).toHaveLength(2);
    expect(view.getAllByText(/^Shared by a step/)).toHaveLength(1);

    const link = view.getByRole("link", { name: "playwright-report" });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/artifact-bundles/${sharedShare.bundleId}`,
    );
  });

  test("offers a copy button only when the share has a url", async () => {
    const view = renderPanel([sharedShare, expiredShare, unavailableShare]);

    expect(view.queryByLabelText("Copy share link for old-report")).toBeNull();
    expect(view.queryByLabelText("Copy share link for screenshots")).toBeNull();

    fireEvent.click(
      view.getByLabelText("Copy share link for playwright-report"),
    );

    await waitFor(() => {
      expect(clipboardWrites).toEqual([SHARE_URL]);
    });
  });

  test("revoke is confirmed, calls DELETE share and removes the row", async () => {
    const view = renderPanel([sharedShare, expiredShare]);

    fireEvent.click(view.getByLabelText("Revoke share link for old-report"));
    expect(revokeCalls).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(revokeCalls).toEqual([expiredShare.bundleId]);
    });
    await waitFor(() => {
      expect(view.queryByText("old-report")).toBeNull();
    });
    expect(view.getByText("playwright-report")).toBeTruthy();
  });

  test("surfaces a revoke error and keeps the row", async () => {
    revokeResult = {
      data: null,
      error: { value: { status: 403, detail: "nope" } },
    };
    const view = renderPanel([sharedShare]);

    fireEvent.click(
      view.getByLabelText("Revoke share link for playwright-report"),
    );
    fireEvent.click(view.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(
        view.getByText("You don't have permission to do this."),
      ).toBeTruthy();
    });
    expect(view.getByText("playwright-report")).toBeTruthy();
  });

  test("hides revoke without executions:write", () => {
    const view = renderPanel([sharedShare], []);

    expect(view.getByText("playwright-report")).toBeTruthy();
    expect(view.queryByLabelText(/^Revoke share link/)).toBeNull();
  });

  test("shows the empty state", () => {
    const view = renderPanel([]);

    expect(view.getByText("No active share links.")).toBeTruthy();
  });

  test("notes when only the newest links are shown", () => {
    const view = renderPanel([sharedShare], ["executions:write"], true);

    expect(
      view.getByText("Only the 50 newest share links are shown."),
    ).toBeTruthy();
  });
});
