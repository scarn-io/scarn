import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  makeStep,
  projectId,
  setupDom,
  editTextInput,
} from "./step-definition-dialog-test-helpers";

// Rendering MUI under jsdom is CPU-heavy; under a loaded machine
// (test-all-workspaces) a single test can overrun bun's 5s default.
let mockPutResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const putMock = mock(() => Promise.resolve(mockPutResult));
const postMock = mock(() => Promise.resolve({ data: null, error: null }));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": {
        put: putMock,
        post: postMock,
      },
    },
  }),
}));

const { StepDefinitionDialog } = await import("./step-definition-dialog");

describe("StepDefinitionDialog environment errors", () => {
  beforeEach(() => {
    setupDom();
    putMock.mockClear();
    postMock.mockClear();
    mockPutResult = { data: null, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  test("an unknown environment name is shown on the environment name field", async () => {
    const detail = 'Environment "missing" not found.';
    const view = render(
      <StepDefinitionDialog
        open
        projectId={projectId}
        step={makeStep({ environment: { kind: "named", name: "shared" } })}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    mockPutResult = {
      data: null,
      error: {
        status: 400,
        value: { status: 400, code: "STEP_ENVIRONMENT_NOT_FOUND", detail },
      },
    };
    editTextInput(
      view.getByLabelText(/Environment name/) as HTMLInputElement,
      "missing",
    );
    const form = view.baseElement.querySelector("form");
    if (!form) throw new Error("Expected a form element");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(view.getByText(detail)).toBeTruthy();
    });
    const input = view.getByLabelText(/Environment name/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(view.baseElement.querySelector(".MuiAlert-root")).toBeNull();
  });
});
