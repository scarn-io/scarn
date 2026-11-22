import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { ProjectArtifactContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// Rendering MUI under jsdom is CPU-heavy; under a loaded machine
// (test-all-workspaces) a single test can overrun bun's 5s default.
const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");

function buildProjectArtifact(
  overrides: Partial<ProjectArtifactContract> = {},
): ProjectArtifactContract {
  return {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
    taskRunId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa699"),
    projectId,
    relativeStorePath: "test-results/foo/trace.zip",
    storeRef: "store-ref",
    objectKey: "object-key",
    sizeBytes: 10,
    contentType: "application/zip",
    kind: "playwright-trace",
    createdAt: "2026-06-05T12:00:00.000Z",
    nodeKey: null,
    ...overrides,
  };
}

type ApiResult = { data: unknown; error: unknown };

let deleteOneResult: ApiResult = { data: 1, error: null };
let deleteManyResult: ApiResult = { data: 2, error: null };
const deleteOneCalls: string[] = [];
const deleteManyCalls: string[][] = [];

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        artifacts: Object.assign(
          (params: { artifactId: string }) => ({
            delete: () => {
              deleteOneCalls.push(params.artifactId);
              return Promise.resolve(deleteOneResult);
            },
          }),
          {
            batch: {
              delete: (body: { input: string[] }) => {
                deleteManyCalls.push(body.input);
                return Promise.resolve(deleteManyResult);
              },
            },
          },
        ),
      }),
    },
  }),
}));

const { ProjectArtifactsPanel } = await import("./project-artifacts-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

// MUI's `Checkbox` places the `aria-label` on the ButtonBase root (a `<span>`),
// not on the underlying `<input type="checkbox">` — the actual element whose
// `onChange` drives selection state. In a real browser, clicking anywhere in
// the root hits the input directly (it's absolutely positioned to cover the
// whole root with `opacity: 0`), but jsdom's `fireEvent.click` dispatches to
// the literal node passed in, so tests must target the nested input.
function clickCheckbox(labelText: string, view: ReturnType<typeof render>) {
  const root = view.getByLabelText(labelText);
  const input = root.querySelector("input");
  if (!input) throw new Error(`No <input> found under checkbox "${labelText}"`);
  fireEvent.click(input);
}

const renderPanel = (
  artifacts: ProjectArtifactContract[],
  permissions: string[] = [],
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
      <ProjectArtifactsPanel
        projectId={projectId}
        initialArtifacts={artifacts}
        initialHasMore={initialHasMore}
      />
    </ProjectRouteProvider>,
  );

describe("ProjectArtifactsPanel", () => {
  beforeEach(() => {
    deleteOneCalls.length = 0;
    deleteManyCalls.length = 0;
    deleteOneResult = { data: 1, error: null };
    deleteManyResult = { data: 2, error: null };

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
  });

  afterEach(() => {
    cleanup();
  });

  test("renders rows with expected meta/chip", () => {
    const artifacts = [
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
        relativeStorePath: "test-results/foo/trace.zip",
        sizeBytes: 2048,
        contentType: "application/zip",
        storeRef: "store-ref",
        nodeKey: "run-tests",
      }),
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
        relativeStorePath: "logs/output.txt",
        sizeBytes: null,
        contentType: null,
        storeRef: null,
        objectKey: null,
        nodeKey: null,
      }),
    ];

    const view = renderPanel(artifacts);

    expect(view.getByText("trace.zip")).toBeTruthy();
    expect(view.getByText("2.0 KiB · application/zip")).toBeTruthy();
    expect(view.getByText("From: run-tests")).toBeTruthy();

    expect(view.getByText("output.txt")).toBeTruthy();
    expect(view.getByText("Expired")).toBeTruthy();
    // Only one "From:" line should exist — the expired row has no nodeKey.
    expect(view.queryAllByText(/^From: /)).toHaveLength(1);
  });

  test("checkbox selection drives the Delete selected button's enabled state and count", () => {
    const artifacts = [
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
        relativeStorePath: "a/one.zip",
      }),
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
        relativeStorePath: "b/two.zip",
      }),
    ];

    const view = renderPanel(artifacts, ["executions:delete"]);

    expect(view.queryByText(/Delete selected/)).toBeNull();

    clickCheckbox("Select one.zip", view);
    expect(view.getByText("Delete selected (1)")).toBeTruthy();

    clickCheckbox("Select two.zip", view);
    expect(view.getByText("Delete selected (2)")).toBeTruthy();
  });

  test("confirmation dialog gates the actual delete call", async () => {
    const artifacts = [
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
        relativeStorePath: "a/one.zip",
      }),
    ];

    const view = renderPanel(artifacts, ["executions:delete"]);

    fireEvent.click(view.getByLabelText("Delete one.zip"));

    expect(deleteOneCalls).toHaveLength(0);

    const confirmButton = view.getByRole("button", { name: "Delete" });
    expect(confirmButton).toBeTruthy();

    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(deleteOneCalls).toEqual(["019e9a92-b432-73e8-9341-3519156fa801"]);
    });
  });

  test("optimistically removes the row after a successful delete", async () => {
    const artifacts = [
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
        relativeStorePath: "a/one.zip",
      }),
    ];

    const view = renderPanel(artifacts, ["executions:delete"]);

    fireEvent.click(view.getByLabelText("Delete one.zip"));
    fireEvent.click(view.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(view.queryByText("one.zip")).toBeNull();
    });
  });

  test("surfaces a parseApiError message on failure and keeps the row", async () => {
    deleteOneResult = {
      data: null,
      error: { value: { status: 403, detail: "nope" } },
    };

    const artifacts = [
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
        relativeStorePath: "a/one.zip",
      }),
    ];

    const view = renderPanel(artifacts, ["executions:delete"]);

    fireEvent.click(view.getByLabelText("Delete one.zip"));
    fireEvent.click(view.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        view.getByText("You don't have permission to do this."),
      ).toBeTruthy();
    });

    expect(view.getByText("one.zip")).toBeTruthy();
  });

  test("hides delete affordances when the caller lacks executions:delete", () => {
    const artifacts = [
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
        relativeStorePath: "a/one.zip",
      }),
      buildProjectArtifact({
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
        relativeStorePath: "b/two.zip",
      }),
    ];

    const view = renderPanel(artifacts, []);

    expect(view.getByText("one.zip")).toBeTruthy();
    expect(view.getByText("two.zip")).toBeTruthy();

    expect(view.queryByLabelText(/^Select /)).toBeNull();
    expect(view.queryByLabelText(/^Delete /)).toBeNull();
    expect(view.queryByText(/Delete selected/)).toBeNull();
  });
});
