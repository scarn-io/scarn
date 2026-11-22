import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  ArtifactContract,
  ArtifactFailureContract,
} from "@scarn/api/frontend-contracts";
import type { ArtifactsStatus } from "./use-task-run-artifacts";
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
    ...overrides,
  };
}

let currentArtifacts: ArtifactContract[] = [];
let currentStatus: ArtifactsStatus = "loaded";
let currentFailures: ArtifactFailureContract[] = [];
const loadMock = mock(() => {});
const getDownloadUrlMock = mock(() =>
  Promise.resolve({
    url: "https://store.example/trace.zip?sig=abc",
    sizeBytes: 10,
    contentType: "application/zip",
    relativeStorePath: "test-results/foo/trace.zip",
  }),
);

void mock.module("./use-task-run-artifacts", () => ({
  useTaskRunArtifacts: () => ({
    artifacts: currentArtifacts,
    status: currentStatus,
    loading: currentStatus === "loading",
    error: "",
    load: loadMock,
    getDownloadUrl: getDownloadUrlMock,
  }),
}));
void mock.module("./use-task-run-artifact-failures", () => ({
  useTaskRunArtifactFailures: () => ({
    artifactFailures: currentFailures,
    status: "loaded",
    loading: false,
    error: "",
    load: () => {},
  }),
}));

const { RunArtifactsCard } = await import("./run-artifacts-card");

describe("RunArtifactsCard", () => {
  let openMock: ReturnType<typeof mock>;

  beforeEach(() => {
    currentArtifacts = [];
    currentStatus = "loaded";
    currentFailures = [];
    loadMock.mockClear();
    getDownloadUrlMock.mockClear();

    installDom();
    openMock = mock(() => null);
    window.open = openMock;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders nothing when the run produced no artifacts", () => {
    const view = render(<RunArtifactsCard taskRunId={taskId} />);
    expect(loadMock).toHaveBeenCalled();
    expect(view.queryByRole("region", { name: "Run artifacts" })).toBeNull();
  });

  test("renders nothing while the list is loading", () => {
    currentStatus = "loading";
    currentArtifacts = [buildArtifact()];
    const view = render(<RunArtifactsCard taskRunId={taskId} />);
    expect(view.queryByRole("region", { name: "Run artifacts" })).toBeNull();
  });

  test("lists the run's artifacts with traces first and a file count", () => {
    currentArtifacts = [
      buildArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa803"),
        kind: "generic",
        relativeStorePath: "reports/investigation.md",
        contentType: "text/markdown",
      }),
      buildArtifact(),
    ];
    const view = render(<RunArtifactsCard taskRunId={taskId} />);

    expect(view.getByRole("region", { name: "Run artifacts" })).toBeTruthy();
    expect(view.getByText("· 2 files")).toBeTruthy();
    const trace = view.getByText("trace.zip");
    const report = view.getByText("investigation.md");
    expect(
      trace.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByLabelText("Download investigation.md")).toBeTruthy();
  });

  test("View Playwright trace opens the trace viewer", async () => {
    currentArtifacts = [buildArtifact()];
    const view = render(<RunArtifactsCard taskRunId={taskId} />);

    fireEvent.click(view.getByLabelText("View Playwright trace trace.zip"));

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        `https://trace.playwright.dev/?trace=${encodeURIComponent("https://store.example/trace.zip?sig=abc")}`,
        "_blank",
        "noopener,noreferrer",
      );
    });
  });
});
