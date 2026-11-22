import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  parseUuidV7,
  type PendingCommentDraftContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

type ApiResult = { data: unknown; error: unknown };

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const VIDEO_ARTIFACT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbea11";
const VIDEO_TASK_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbea12";
const VIDEO_URL = "https://store.test/get/repro.mp4";

let approveResult: ApiResult = { data: null, error: null };

const approveMock = mock(() => Promise.resolve(approveResult));
const projectArtifactGetMock = mock(() =>
  Promise.resolve({
    data: {
      id: VIDEO_ARTIFACT_ID,
      taskRunId: VIDEO_TASK_ID,
      projectId: PROJECT_ID,
      relativeStorePath: "repro.mp4",
      sizeBytes: 4096,
      contentType: "video/mp4",
      kind: "video",
      createdAt: "2026-04-26T12:00:00.000Z",
      status: "available",
      pipelineRunId: null,
      attemptNumber: null,
      nodeKey: null,
    },
    error: null,
  }),
);
const downloadUrlGetMock = mock(() =>
  Promise.resolve({
    data: {
      url: VIDEO_URL,
      sizeBytes: 4096,
      contentType: "video/mp4",
      relativeStorePath: "repro.mp4",
    },
    error: null,
  }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-item-comment-drafts": () => ({
        approve: { post: approveMock },
        reject: {
          post: mock(() => Promise.resolve({ data: null, error: null })),
        },
      }),
      projects: () => ({
        artifacts: () => ({ get: projectArtifactGetMock }),
      }),
      "task-runs": () => ({
        artifacts: () => ({ "download-url": { get: downloadUrlGetMock } }),
      }),
    },
  }),
}));

const { WorkItemCommentDraftItem } =
  await import("./work-item-comment-draft-item");

type ArtifactResolution = NonNullable<
  PendingCommentDraftContract["artifactResolution"]
>;

const buildArtifactResolution = (
  overrides: Partial<ArtifactResolution> = {},
): ArtifactResolution => ({
  markers: [],
  leftOut: [],
  warnings: [],
  ...overrides,
});

const buildDraft = (
  body: string,
  artifactResolution: ArtifactResolution | null = null,
): PendingCommentDraftContract =>
  ({
    notification: {
      id: "01966a2c-9494-7db5-aa46-0f8f5cbbe801",
      projectId: PROJECT_ID,
      workItemId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
      pipelineExecutionId: null,
      taskId: null,
      agentSessionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe701",
      kind: "status_update",
      audience: "assignee",
      title: "Draft reply",
      body,
      priority: "normal",
      source: "agent",
      status: "pending",
      payloadJson: null,
      createdAt: "2026-04-26T12:00:00.000Z",
      updatedAt: "2026-04-26T12:00:00.000Z",
    },
    lastError: null,
    artifactResolution,
  }) as PendingCommentDraftContract;

const renderDraft = (draft: PendingCommentDraftContract) =>
  render(
    <WorkItemCommentDraftItem
      draft={draft}
      workItemPlatform="github"
      onApproved={mock(() => {})}
      onRejected={mock(() => {})}
    />,
  );

describe("WorkItemCommentDraftItem — artifact markers", () => {
  beforeEach(() => {
    installDom({ url: "https://app.scarn.io/" });
    Object.assign(globalThis, {
      requestAnimationFrame: (cb: FrameRequestCallback) =>
        setTimeout(() => {
          cb(Date.now());
        }, 0) as unknown as number,
      cancelAnimationFrame: (id: number) => {
        clearTimeout(id);
      },
    });

    approveResult = { data: null, error: null };
    approveMock.mockClear();
    projectArtifactGetMock.mockClear();
    downloadUrlGetMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("a 422 artifact_unavailable approval shows the blocked banner naming each marker", async () => {
    approveResult = {
      data: null,
      error: {
        status: 422,
        value: {
          status: 422,
          code: "artifact_unavailable",
          detail: "One or more artifacts are no longer available",
          meta: {
            markers: [
              { markerIndex: 1, caption: "Console log", reason: "expired" },
            ],
          },
        },
      },
    };

    const view = renderDraft(buildDraft("Thanks for reporting this."));
    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(view.getByText("Can't post this comment yet")).toBeTruthy();
    });
    expect(view.getByText("Console log")).toBeTruthy();
    expect(view.getByText(/the file has expired/)).toBeTruthy();
    expect(
      view.queryByText("Could not approve this comment. Try again."),
    ).toBeNull();
  });

  test("left-out artifacts are listed in a side panel with their reasons", () => {
    const view = renderDraft(
      buildDraft(
        "Repro below.",
        buildArtifactResolution({
          leftOut: [
            {
              markerIndex: 1,
              ref: { type: "path", pattern: "shots/missing-*.png" },
              caption: "Missing screenshot",
              reason: "no_match",
            },
          ],
        }),
      ),
    );

    expect(view.getByText("Left out")).toBeTruthy();
    expect(view.getByText("Missing screenshot")).toBeTruthy();
    expect(view.getByText("no saved file matched")).toBeTruthy();
  });

  test("a resolved standalone embed marker renders an inline video preview", async () => {
    const view = renderDraft(
      buildDraft(
        "Repro below.\n\n![Repro video](artifact:signal/record/repro)",
        buildArtifactResolution({
          markers: [
            {
              markerIndex: 0,
              kind: "embed",
              ref: { type: "signal", stepKey: "record", signalKey: "repro" },
              caption: "Repro video",
              standalone: true,
              status: "resolved",
              required: true,
              reason: null,
              artifact: {
                artifactId: parseUuidV7(VIDEO_ARTIFACT_ID),
                name: "repro.mp4",
                contentType: "video/mp4",
                kind: "video",
                sizeBytes: 4096,
              },
            },
          ],
        }),
      ),
    );

    expect(view.getByText("Preview")).toBeTruthy();
    expect(view.getByText("repro.mp4").getAttribute("href")).toBe(
      `/projects/${PROJECT_ID}/artifacts/${VIDEO_ARTIFACT_ID}`,
    );
    await waitFor(() => {
      expect(view.getByLabelText("repro.mp4").getAttribute("src")).toBe(
        VIDEO_URL,
      );
    });
  });

  test("an embed marker with no resolution entry says it hasn't been checked yet", () => {
    const view = renderDraft(
      buildDraft(
        "New file:\n\n![Fresh shot](artifact:shots/new.png)",
        buildArtifactResolution(),
      ),
    );

    expect(
      view.getByText("Not checked yet — approve to check this file"),
    ).toBeTruthy();
    expect(projectArtifactGetMock).not.toHaveBeenCalled();
  });

  test("a body without markers shows no preview", () => {
    const view = renderDraft(buildDraft("Thanks for reporting this."));

    expect(view.queryByText("Preview")).toBeNull();
  });
});
