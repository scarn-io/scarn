import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import {
  parseUuidV7,
  type ArtifactContract,
  type ProjectArtifactBundleDetailContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

installDom();

type ApiResult = { data: unknown; error: unknown };

const PROJECT_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
const BUNDLE_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901");
const TASK_RUN_ID = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699");
const PREVIEW_TTL_MS = 15 * 60_000;

let previewResult: () => ApiResult = () => ({ data: null, error: null });
const previewMock = mock(() => Promise.resolve(previewResult()));
const shareGetMock = mock(() =>
  Promise.resolve({
    data: {
      bundleId: BUNDLE_ID,
      status: "private",
      reason: null,
      url: null,
      expiresAt: "2026-12-20T12:00:00.000Z",
      shareDeclared: false,
      share: null,
    },
    error: null,
  }),
);

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        "artifact-bundles": () => ({
          preview: { post: previewMock },
          share: {
            get: shareGetMock,
            post: () => Promise.reject(new Error("not needed")),
            delete: () => Promise.reject(new Error("not needed")),
          },
        }),
      }),
    },
  }),
}));

const { act, cleanup, render } = await import("@testing-library/react");
const { ArtifactBundlePageClient, PREVIEW_UNAVAILABLE_MESSAGE } =
  await import("./artifact-bundle-page-client");

function buildMember(): ArtifactContract {
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
  };
}

function buildBundle(
  overrides: Partial<ProjectArtifactBundleDetailContract> = {},
): ProjectArtifactBundleDetailContract {
  return {
    id: BUNDLE_ID,
    taskRunId: TASK_RUN_ID,
    projectId: PROJECT_ID,
    name: "site",
    fieldPath: null,
    rootPath: "out/site",
    entryPath: "index.html",
    status: "ready",
    fileCount: 1,
    sizeBytes: 2048,
    createdAt: "2026-11-20T12:00:00.000Z",
    finalizedAt: "2026-11-20T12:00:01.000Z",
    expiresAt: "2026-12-20T12:00:00.000Z",
    expired: false,
    deleted: false,
    members: [buildMember()],
    ...overrides,
  };
}

let mintCount = 0;
const mintPreview = (): ApiResult => {
  mintCount += 1;
  return {
    data: {
      url: `https://content.example.test/p/pv1.token${String(mintCount)}/`,
      expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    },
    error: null,
  };
};

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });
};

describe("ArtifactBundlePageClient", () => {
  beforeEach(() => {
    mintCount = 0;
    previewResult = mintPreview;
    previewMock.mockClear();
    shareGetMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
  });

  test("previews the bundle in a frame that never shares the app's origin", async () => {
    const view = render(
      <ArtifactBundlePageClient
        bundle={buildBundle()}
        project={{ name: "Demo" }}
      />,
    );
    await flush();

    const frame = view.getByTitle("Preview of site");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(
      "https://content.example.test/p/pv1.token1/",
    );
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(view.getByText("index.html")).toBeTruthy();
    expect(view.getByLabelText("Download index.html")).toBeTruthy();
  });

  test("mints a fresh preview shortly before the token expires", async () => {
    jest.useFakeTimers();
    const view = render(
      <ArtifactBundlePageClient
        bundle={buildBundle()}
        project={{ name: "Demo" }}
      />,
    );
    await flush();
    expect(previewMock).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(PREVIEW_TTL_MS - 2 * 60_000);
    });
    await flush();
    expect(previewMock).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(60_000 + 1_000);
    });
    await flush();
    expect(previewMock).toHaveBeenCalledTimes(2);
    expect(view.getByTitle("Preview of site").getAttribute("src")).toBe(
      "https://content.example.test/p/pv1.token2/",
    );
  });

  test("says preview isn't available when sharing is off on this server", async () => {
    previewResult = () => ({
      data: null,
      error: {
        status: 409,
        value: { status: 409, code: "ARTIFACT_SHARING_DISABLED" },
      },
    });
    const view = render(
      <ArtifactBundlePageClient
        bundle={buildBundle()}
        project={{ name: "Demo" }}
      />,
    );
    await flush();
    expect(view.getByText(PREVIEW_UNAVAILABLE_MESSAGE)).toBeTruthy();
    expect(view.queryByTitle("Preview of site")).toBeNull();
  });

  test("an expired bundle gets no preview", async () => {
    const view = render(
      <ArtifactBundlePageClient
        bundle={buildBundle({ expired: true })}
        project={{ name: "Demo" }}
      />,
    );
    await flush();
    expect(previewMock).not.toHaveBeenCalled();
    expect(
      view.getByText("This bundle has expired and is no longer available."),
    ).toBeTruthy();
  });
});
