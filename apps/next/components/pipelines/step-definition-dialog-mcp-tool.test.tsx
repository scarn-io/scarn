import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  makeStep,
  projectId,
  setupDom,
} from "./step-definition-dialog-test-helpers";

const putMock = mock(() => Promise.resolve({ data: null, error: null }));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: { "step-definitions": { put: putMock, post: putMock } },
  }),
}));

const { StepDefinitionDialog } = await import("./step-definition-dialog");

const toolStep = makeStep({
  key: "create-issue",
  name: "Create issue",
  kind: "mcp_tool",
  prompt: null,
  healthChecksJson: null,
  toolCallJson: {
    server: "linear",
    tool: "create_issue",
    argsTemplate: { title: { $input: "title" } },
    toolSchemas: {
      input: { type: "object", properties: { title: { type: "string" } } },
      output: null,
    },
  },
  resultSchemaJson: { type: "object", properties: { id: { type: "string" } } },
});

describe("StepDefinitionDialog for an MCP tool step", () => {
  beforeEach(() => {
    setupDom();
    putMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the tool call read-only, with no save or prompt editor", () => {
    const view = render(
      <StepDefinitionDialog
        open
        projectId={projectId}
        step={toolStep}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );

    expect(view.getByText("linear")).toBeTruthy();
    expect(view.getByText("create_issue")).toBeTruthy();
    expect(view.getByLabelText("Args template").textContent).toContain(
      '"$input": "title"',
    );
    expect(view.getByText("The tool declares no output schema.")).toBeTruthy();
    expect(view.getByText("scarn mcp pull")).toBeTruthy();
    expect(view.queryByRole("button", { name: /Save|Create Step/ })).toBeNull();
    expect(view.queryByLabelText(/Agent prompt/)).toBeNull();
    expect(view.baseElement.querySelector("form")).toBeNull();
    expect(view.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
