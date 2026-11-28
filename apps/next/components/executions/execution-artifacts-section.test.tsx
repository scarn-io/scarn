import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  ArtifactBundleContract,
  ArtifactContract,
  ArtifactDownloadUrlContract,
  ArtifactFailureContract,
} from "@scarn/api/frontend-contracts";
import { humanizeArtifactFailureReason } from "./humanize-artifact-failure-reason";
import { installDom } from "@/tests/support/install-dom";

const taskId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699");

function buildArtifact(
  overrides: Partial<ArtifactContract> = {},
): ArtifactContract {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
    taskRunId: taskId,
    projectId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
    relativeStorePath: "test-results/foo/trace.zip",
    storeRef: "store-ref",
    objectKey: "object-key",
    sizeBytes: 10,
    contentType: "application/zip",
    kind: "playwright-trace",
    createdAt: "2026-06-05T12:00:00.000Z",
    bundleId: null,
    ...overrides,
  };
}

function buildArtifactFailure(
  overrides: Partial<ArtifactFailureContract> = {},
): ArtifactFailureContract {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
    taskRunId: taskId,
    relativeStorePath: "reports/summary.json",
    attemptedSizeBytes: 2048,
    kind: "generic",
    errorCode: "UPLOAD_HTTP_ERROR",
    errorMessage: "Upload request failed",
    httpStatus: 502,
    createdAt: "2026-06-05T12:05:00.000Z",
    ...overrides,
  };
}

const loadMock = mock(() => {});
const getDownloadUrlMock = mock(
  (artifactId: string): Promise<ArtifactDownloadUrlContract | null> => {
    void artifactId;
    return Promise.resolve({
      url: "https://store.example/trace.zip?sig=abc",
      sizeBytes: 10,
      contentType: "application/zip",
      relativeStorePath: "test-results/foo/trace.zip",
    });
  },
);

let currentArtifacts: ArtifactContract[] = [];
let currentBundles: ArtifactBundleContract[] = [];
// Read dynamically (rather than captured once) so a test can flip it — e.g.
// simulating the hook's `error` state after a failed `getDownloadUrl` call —
// and have the next render (triggered by the component's own state updates)
// pick up the new value.
let currentError = "";

void mock.module("./use-task-run-artifacts", () => ({
  useTaskRunArtifacts: () => ({
    artifacts: currentArtifacts,
    bundles: currentBundles,
    status: "loaded",
    loading: false,
    error: currentError,
    load: loadMock,
    getDownloadUrl: getDownloadUrlMock,
  }),
}));

// Phase 4 adds a sibling failures list alongside the artifacts list above.
// Mocked here (rather than left to hit the real hook/network) so failure-row
// coverage (Phase 5) can drive the hook's return value per test via
// `currentArtifactFailures`, the same pattern used for `currentArtifacts`
// above.
const loadFailuresMock = mock(() => {});
let currentArtifactFailures: ArtifactFailureContract[] = [];
void mock.module("./use-task-run-artifact-failures", () => ({
  useTaskRunArtifactFailures: () => ({
    artifactFailures: currentArtifactFailures,
    status: "loaded",
    loading: false,
    error: "",
    load: loadFailuresMock,
  }),
}));

const { ProjectRouteProvider } =
  await import("@/components/project-route-context");
const { ExecutionArtifactsSection } =
  await import("./execution-artifacts-section");

const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802");
const bundleId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");

function buildBundle(
  overrides: Partial<ArtifactBundleContract> = {},
): ArtifactBundleContract {
  return {
    id: bundleId,
    taskRunId: taskId,
    projectId,
    name: "site",
    fieldPath: null,
    rootPath: "out/site",
    entryPath: "index.html",
    status: "ready",
    fileCount: 2,
    sizeBytes: 3072,
    createdAt: "2026-06-05T12:00:00.000Z",
    finalizedAt: "2026-06-05T12:01:00.000Z",
    expiresAt: "2026-07-05T12:00:00.000Z",
    expired: false,
    ...overrides,
  };
}

const renderSection = (permissions: string[] = ["executions:write"]) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={projectId}
      isMember
      permissions={permissions}
    >
      <ExecutionArtifactsSection taskRunId={taskId} />
    </ProjectRouteProvider>,
  );

describe("ExecutionArtifactsSection", () => {
  let openMock: ReturnType<typeof mock>;

  beforeEach(() => {
    loadMock.mockClear();
    getDownloadUrlMock.mockClear();
    getDownloadUrlMock.mockImplementation(() =>
      Promise.resolve({
        url: "https://store.example/trace.zip?sig=abc",
        sizeBytes: 10,
        contentType: "application/zip",
        relativeStorePath: "test-results/foo/trace.zip",
      }),
    );
    currentArtifacts = [];
    currentBundles = [];
    currentArtifactFailures = [];
    currentError = "";
    loadFailuresMock.mockClear();

    installDom();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
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
      writable: true,
    });

    openMock = mock(() => null);
    window.open = openMock;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders a View trace control before Download for a playwright-trace artifact", () => {
    currentArtifacts = [buildArtifact()];

    const view = renderSection();

    const viewTrace = view.getByLabelText("View Playwright trace trace.zip");
    const download = view.getByLabelText("Download trace.zip");

    expect(viewTrace).toBeTruthy();
    expect(download).toBeTruthy();
    expect(
      viewTrace.compareDocumentPosition(download) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("renders only a Download control for a generic artifact", () => {
    currentArtifacts = [
      buildArtifact({
        kind: "generic",
        relativeStorePath: "logs/output.txt",
        contentType: "text/plain",
      }),
    ];

    const view = renderSection();

    expect(view.getByLabelText("Download output.txt")).toBeTruthy();
    expect(view.queryByLabelText(/^View Playwright trace/)).toBeNull();
  });

  test("clicking View trace mints a URL and opens the Playwright viewer", async () => {
    currentArtifacts = [buildArtifact()];

    const view = renderSection();

    fireEvent.click(view.getByLabelText("View Playwright trace trace.zip"));

    await waitFor(() => {
      expect(getDownloadUrlMock).toHaveBeenCalledTimes(1);
      expect(openMock).toHaveBeenCalledTimes(1);
    });

    const expectedUrl = `https://trace.playwright.dev/?trace=${encodeURIComponent(
      "https://store.example/trace.zip?sig=abc",
    )}`;
    expect(openMock).toHaveBeenCalledWith(
      expectedUrl,
      "_blank",
      "noopener,noreferrer",
    );
  });

  test("greys out an expired artifact row and disables its actions", () => {
    currentArtifacts = [
      buildArtifact({
        storeRef: null,
        objectKey: null,
        sizeBytes: null,
        contentType: null,
      }),
    ];

    const view = renderSection();

    expect(view.getByText("Expired")).toBeTruthy();
    const download = view.getByLabelText(
      "Download trace.zip",
    ) as HTMLButtonElement;
    const viewTrace = view.getByLabelText(
      "View Playwright trace trace.zip",
    ) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    expect(viewTrace.disabled).toBe(true);
  });

  test("surfaces a distinct message when a download hits an expired artifact", async () => {
    currentArtifacts = [
      buildArtifact({ kind: "generic", relativeStorePath: "logs/output.txt" }),
    ];
    // Simulates the artifact expiring between the list load and the download
    // click (the 410 `ArtifactExpiredError` path) — the hook surfaces this
    // via its `error` state rather than a successful `{ url: null }` result.
    getDownloadUrlMock.mockImplementation(() => {
      currentError = "This artifact has expired and is no longer available.";
      return Promise.resolve(null);
    });

    const view = renderSection();

    fireEvent.click(view.getByLabelText("Download output.txt"));

    await waitFor(() => {
      expect(
        view.getByText("This artifact has expired and is no longer available."),
      ).toBeTruthy();
    });
  });

  test("shows the No artifacts empty state when both lists are empty", () => {
    currentArtifacts = [];
    currentArtifactFailures = [];

    const view = renderSection();

    expect(view.getByText("No artifacts")).toBeTruthy();
  });

  test("suppresses the No artifacts empty state when failures exist but artifacts is empty", () => {
    currentArtifacts = [];
    currentArtifactFailures = [buildArtifactFailure()];

    const view = renderSection();

    expect(view.queryByText("No artifacts")).toBeNull();
  });

  test("shows a singular-pluralized warning banner for one failure", () => {
    currentArtifactFailures = [buildArtifactFailure()];

    const view = renderSection();

    expect(
      view.getByText("1 artifact failed to save for this step."),
    ).toBeTruthy();
  });

  test("shows a plural-pluralized warning banner for multiple failures", () => {
    currentArtifactFailures = [
      buildArtifactFailure({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
      }),
      buildArtifactFailure({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa803"),
        relativeStorePath: "reports/second.json",
      }),
    ];

    const view = renderSection();

    expect(
      view.getByText("2 artifacts failed to save for this step."),
    ).toBeTruthy();
  });

  test("renders failure rows above successful artifact rows, with an Upload failed chip and humanized tooltip", () => {
    const failure = buildArtifactFailure({
      relativeStorePath: "reports/upload-failure.json",
      kind: "playwright-trace",
      errorCode: "USAGE_LIMIT_EXCEEDED_STORAGE",
      errorMessage: "Organization storage usage limit reached",
    });
    currentArtifactFailures = [failure];
    currentArtifacts = [
      buildArtifact({ kind: "generic", relativeStorePath: "logs/output.txt" }),
    ];

    const view = renderSection();

    const failureName = view.getByText("upload-failure.json");
    const artifactName = view.getByText("output.txt");
    expect(
      failureName.compareDocumentPosition(artifactName) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const chip = view.getByText("Upload failed");
    expect(chip).toBeTruthy();

    // MUI's `Tooltip` (default `describeChild={false}`) exposes its `title`
    // via `aria-label` on the wrapped child rather than a native `title`
    // attribute, so the humanized reason is queryable by accessible name.
    const expectedReason = humanizeArtifactFailureReason(failure);
    expect(view.getByLabelText(expectedReason)).toBeTruthy();
  });

  test("collapses a bundle's files into one row and keeps loose files", () => {
    currentBundles = [buildBundle()];
    currentArtifacts = [
      buildArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa804"),
        kind: "generic",
        relativeStorePath: "out/site/index.html",
        bundleId,
      }),
      buildArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa805"),
        kind: "generic",
        relativeStorePath: "out/site/app.js",
        bundleId,
      }),
      buildArtifact({ kind: "generic", relativeStorePath: "logs/output.txt" }),
    ];

    const view = renderSection();

    expect(view.getByText("site")).toBeTruthy();
    expect(view.getByText("2 files · 3.0 KiB")).toBeTruthy();
    expect(view.queryByText("index.html")).toBeNull();
    expect(view.queryByText("app.js")).toBeNull();
    expect(view.getByLabelText("Download output.txt")).toBeTruthy();
    expect(view.getByLabelText("Open site").getAttribute("href")).toBe(
      `/projects/${projectId}/artifact-bundles/${bundleId}`,
    );
  });

  test("a member whose bundle isn't listed stays a loose file", () => {
    currentArtifacts = [
      buildArtifact({
        kind: "generic",
        relativeStorePath: "out/site/index.html",
        bundleId,
      }),
    ];

    const view = renderSection();

    expect(view.getByText("index.html")).toBeTruthy();
    expect(view.queryByLabelText("Open site")).toBeNull();
  });

  test("hides Share without executions:write", () => {
    currentBundles = [buildBundle()];

    const view = renderSection([]);

    expect(view.getByLabelText("Open site")).toBeTruthy();
    expect(view.queryByLabelText("Share site")).toBeNull();
  });

  test("a bundle with no files still suppresses the empty state", () => {
    currentBundles = [buildBundle({ status: "pending", fileCount: null })];

    const view = renderSection();

    expect(view.queryByText("No artifacts")).toBeNull();
    expect(view.getByText("site")).toBeTruthy();
  });
});
