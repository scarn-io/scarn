import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  parseUuidV7,
  type ArtifactBundleContract,
  type ArtifactContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";
import { shareWarning } from "@/components/artifacts/artifact-share-panel";
import type { ArtifactActions } from "./use-artifact-actions";

installDom();

type ApiResult = { data: unknown; error: unknown };

const PROJECT_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
const BUNDLE_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901");
const TASK_RUN_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699");
const SHARE_URL = "https://content.example.test/s/token";
const SHARE_EXPIRES_AT = "2026-12-20T12:00:00.000Z";

const shareBody = (status: string, url: string | null = null) => ({
  bundleId: BUNDLE_ID,
  status,
  reason: null,
  url,
  expiresAt: SHARE_EXPIRES_AT,
  shareDeclared: false,
  share: null,
});

let postResult: () => ApiResult = () => ({ data: null, error: null });
let getResult: () => ApiResult = () => ({ data: null, error: null });
const sharePostMock = mock(() => Promise.resolve(postResult()));
const shareGetMock = mock(() => Promise.resolve(getResult()));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        "artifact-bundles": () => ({
          share: {
            get: shareGetMock,
            post: sharePostMock,
            delete: () => Promise.reject(new Error("not needed")),
          },
        }),
      }),
    },
  }),
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ArtifactBundleActions, groupArtifactsByBundle } =
  await import("./artifact-bundle-actions");

function buildBundle(
  overrides: Partial<ArtifactBundleContract> = {},
): ArtifactBundleContract {
  return {
    id: BUNDLE_ID,
    taskRunId: TASK_RUN_ID,
    projectId: PROJECT_ID,
    name: "site",
    fieldPath: null,
    rootPath: "out/site",
    entryPath: "index.html",
    status: "ready",
    fileCount: 2,
    sizeBytes: 3072,
    createdAt: "2026-11-20T12:00:00.000Z",
    finalizedAt: "2026-11-20T12:01:00.000Z",
    expiresAt: SHARE_EXPIRES_AT,
    expired: false,
    ...overrides,
  };
}

function buildMember(
  overrides: Partial<ArtifactContract> = {},
): ArtifactContract {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
    taskRunId: TASK_RUN_ID,
    projectId: PROJECT_ID,
    relativeStorePath: "out/site/index.html",
    storeRef: "store-ref",
    objectKey: "object-key",
    sizeBytes: 2048,
    contentType: "text/html",
    kind: "generic",
    createdAt: "2026-11-20T12:00:00.000Z",
    bundleId: BUNDLE_ID,
    ...overrides,
  };
}

const downloadMock = mock(() => Promise.resolve());
const actions: ArtifactActions = {
  downloadingIds: new Set(),
  viewingTraceIds: new Set(),
  actionError: "",
  download: downloadMock,
  viewTrace: () => Promise.resolve(),
};

const renderActions = (
  bundle: ArtifactBundleContract,
  {
    canShare = true,
    entry = buildMember(),
  }: { canShare?: boolean; entry?: ArtifactContract | null } = {},
) =>
  render(
    <ArtifactBundleActions
      bundle={bundle}
      entryArtifact={entry ?? undefined}
      actions={actions}
      canShare={canShare}
    />,
  );

const isDisabled = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled ||
  element.getAttribute("aria-disabled") === "true";

describe("ArtifactBundleActions", () => {
  beforeEach(() => {
    sharePostMock.mockClear();
    shareGetMock.mockClear();
    downloadMock.mockClear();
    postResult = () => ({
      data: shareBody("shared", SHARE_URL),
      error: null,
    });
    getResult = () => ({ data: shareBody("private"), error: null });
  });

  afterEach(() => {
    cleanup();
  });

  test("doesn't load the share state on mount", () => {
    renderActions(buildBundle());
    expect(shareGetMock).not.toHaveBeenCalled();
  });

  test("Open links to the bundle page", () => {
    const view = renderActions(buildBundle());
    expect(view.getByLabelText("Open site").getAttribute("href")).toBe(
      `/projects/${PROJECT_ID}/artifact-bundles/${BUNDLE_ID}`,
    );
  });

  test("Share creates the link and shows it with the public-access warning", async () => {
    const view = renderActions(buildBundle());

    fireEvent.click(view.getByLabelText("Share site"));

    await waitFor(() => {
      expect(view.getByText(SHARE_URL)).toBeTruthy();
    });
    expect(sharePostMock).toHaveBeenCalledTimes(1);
    expect(view.getByText(shareWarning(SHARE_EXPIRES_AT))).toBeTruthy();
    expect(view.getByLabelText("Copy share link")).toBeTruthy();
  });

  test("Share says so when sharing is off on this server", async () => {
    postResult = () => ({
      data: null,
      error: {
        status: 409,
        value: { status: 409, code: "ARTIFACT_SHARING_DISABLED" },
      },
    });
    getResult = () => ({ data: shareBody("unavailable"), error: null });
    const view = renderActions(buildBundle());

    fireEvent.click(view.getByLabelText("Share site"));

    await waitFor(() => {
      expect(view.getAllByText("Sharing is off on this server.")).toBeTruthy();
    });
    expect(view.queryByText(SHARE_URL)).toBeNull();
  });

  test("Share shows the error when the request fails", async () => {
    postResult = () => ({
      data: null,
      error: { status: 500, value: { status: 500, title: "Boom" } },
    });
    getResult = () => ({ data: null, error: { status: 500 } });
    const view = renderActions(buildBundle());

    fireEvent.click(view.getByLabelText("Share site"));

    await waitFor(() => {
      expect(view.getByRole("alert")).toBeTruthy();
    });
    expect(view.queryByText(SHARE_URL)).toBeNull();
  });

  test("Download downloads the entry file", () => {
    const entry = buildMember();
    const view = renderActions(buildBundle(), { entry });

    fireEvent.click(view.getByLabelText("Download site"));

    expect(downloadMock).toHaveBeenCalledWith(entry);
  });

  test("Download is disabled when the entry file isn't listed", () => {
    const view = renderActions(buildBundle(), { entry: null });
    expect(isDisabled(view.getByLabelText("Download site"))).toBe(true);
  });

  test("a pending bundle reads Uploading and disables every action", () => {
    const view = renderActions(
      buildBundle({ status: "pending", fileCount: null, sizeBytes: null }),
    );
    expect(view.getByText("Uploading")).toBeTruthy();
    expect(isDisabled(view.getByLabelText("Open site"))).toBe(true);
    expect(isDisabled(view.getByLabelText("Share site"))).toBe(true);
    expect(isDisabled(view.getByLabelText("Download site"))).toBe(true);
  });

  test("a failed bundle can be opened but not shared or downloaded", () => {
    const view = renderActions(buildBundle({ status: "failed" }));
    expect(view.getByText("Failed")).toBeTruthy();
    expect(view.getByLabelText("Open site").getAttribute("href")).toBeTruthy();
    expect(isDisabled(view.getByLabelText("Share site"))).toBe(true);
    expect(isDisabled(view.getByLabelText("Download site"))).toBe(true);
  });

  test("an expired bundle can be opened but not shared or downloaded", () => {
    const view = renderActions(buildBundle({ expired: true }));
    expect(view.getByText("Expired")).toBeTruthy();
    expect(view.getByLabelText("Open site").getAttribute("href")).toBeTruthy();
    expect(isDisabled(view.getByLabelText("Share site"))).toBe(true);
    expect(isDisabled(view.getByLabelText("Download site"))).toBe(true);
  });

  test("hides Share when the viewer can't share", () => {
    const view = renderActions(buildBundle(), { canShare: false });
    expect(view.queryByLabelText("Share site")).toBeNull();
  });
});

describe("groupArtifactsByBundle", () => {
  test("collapses members into their bundle and finds the entry file", () => {
    const entry = buildMember();
    const other = buildMember({
      id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
      relativeStorePath: "out/site/app.js",
    });
    const loose = buildMember({
      id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa803"),
      relativeStorePath: "report.md",
      bundleId: null,
    });

    const grouped = groupArtifactsByBundle(
      [entry, other, loose],
      [buildBundle()],
    );

    expect(grouped.bundles.map((bundle) => bundle.id)).toEqual([BUNDLE_ID]);
    expect(grouped.loose).toEqual([loose]);
    expect(grouped.entryArtifacts.get(BUNDLE_ID)).toEqual(entry);
  });

  test("keeps a member loose when its bundle isn't listed", () => {
    const member = buildMember();
    const grouped = groupArtifactsByBundle([member], []);
    expect(grouped.loose).toEqual([member]);
  });
});
