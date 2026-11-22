import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import {
  editTextInput,
  makeStep,
  projectId,
  setupDom,
  type SavedStepBody,
} from "./step-definition-dialog-test-helpers";

// Rendering MUI under jsdom is CPU-heavy; under a loaded machine
// (test-all-workspaces) a single test can overrun bun's 5s default.
let mockPutResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const putMock = mock((body: SavedStepBody) => {
  void body;
  return Promise.resolve(mockPutResult);
});

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": {
        put: putMock,
        post: mock(() => Promise.resolve({ data: null, error: null })),
      },
    },
  }),
}));

const { StepDefinitionDialog } = await import("./step-definition-dialog");

type Edit = { from: string; to: RegExp } | { baseBranch: string };

async function saveWith(
  step: StepDefinitionContract,
  edits: Edit[],
): Promise<{ body: SavedStepBody; view: ReturnType<typeof render> }> {
  mockPutResult = { data: step, error: null };
  const view = render(
    <StepDefinitionDialog
      open
      projectId={projectId}
      step={step}
      onSaved={() => {}}
      onClose={() => {}}
    />,
  );
  for (const edit of edits) {
    if ("baseBranch" in edit) {
      editTextInput(
        view.getByLabelText(/Base branch/) as HTMLInputElement,
        edit.baseBranch,
      );
      continue;
    }
    const select = Array.from(
      view.baseElement.querySelectorAll('[role="combobox"]'),
    ).find((element) => element.textContent === edit.from);
    if (!select) throw new Error(`Expected a select showing ${edit.from}`);
    fireEvent.mouseDown(select);
    const option = await waitFor(() => {
      const found = Array.from(
        view.baseElement.querySelectorAll('[role="option"]'),
      ).find((element) => edit.to.test(element.textContent));
      if (!found)
        throw new Error(`Expected an option matching ${String(edit.to)}`);
      return found;
    });
    fireEvent.click(option);
  }
  const form = view.baseElement.querySelector("form");
  if (!form) throw new Error("Expected a form element");
  fireEvent.submit(form);
  await waitFor(() => {
    expect(putMock).toHaveBeenCalledTimes(1);
  });
  const call = putMock.mock.calls[0];
  if (!call) throw new Error("Expected a PUT");
  return { body: call[0], view };
}

const customRepo = {
  mode: "readWrite",
  message: "fix: {{result.summary}}",
  onPushFailure: "warn",
  gitCredentials: "auto",
  baseBranch: "release/{{input.version}}",
  workBranch: { kind: "base" },
} as const;

describe("StepDefinitionDialog repo branches", () => {
  beforeEach(() => {
    setupDom();
    putMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows a step's branch settings", async () => {
    const { view } = await saveWith(makeStep({ repo: customRepo }), []);
    expect((view.getByLabelText(/Base branch/) as HTMLInputElement).value).toBe(
      "release/{{input.version}}",
    );
    const shown = Array.from(
      view.baseElement.querySelectorAll('[role="combobox"]'),
    ).map((element) => element.textContent);
    expect(shown).toContain("Commit onto the branch it started from");
  });

  test("edits base branch and work branch", async () => {
    const { body } = await saveWith(makeStep(), [
      { baseBranch: "ephemeral-{{env.TICKET}}" },
      { from: "Create a new branch", to: /^commit onto/i },
    ]);
    expect(body.repo).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: "ephemeral-{{env.TICKET}}",
      workBranch: { kind: "base" },
    });
  });

  test("a cleared base branch saves as null", async () => {
    const { body } = await saveWith(makeStep({ repo: customRepo }), [
      { baseBranch: "  " },
    ]);
    expect(body.repo).toEqual({ ...customRepo, baseBranch: null });
  });

  test("read-only access drops the work branch and keeps the rest", async () => {
    const { body, view } = await saveWith(makeStep({ repo: customRepo }), [
      { from: "Read / write", to: /^read only$/i },
    ]);
    expect(body.repo).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      baseBranch: "release/{{input.version}}",
    });
    expect(view.queryByLabelText(/Work branch/)).toBeNull();
  });

  test("repository access is editable independently of environment", async () => {
    const { body } = await saveWith(makeStep(), [
      { from: "Read / write", to: /^read only$/i },
    ]);
    expect(body.repo).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      baseBranch: null,
    });
    expect(body.environment).toBeNull();
  });

  test("repository credentials edits preserve custom write behavior", async () => {
    const { body } = await saveWith(makeStep({ repo: customRepo }), [
      { from: "Automatic", to: /^none$/i },
    ]);
    expect(body.repo).toEqual({ ...customRepo, gitCredentials: "none" });
    expect(body.environment).toBeNull();
  });
});
