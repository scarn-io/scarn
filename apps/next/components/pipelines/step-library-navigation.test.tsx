import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import {
  apiState,
  cleanup,
  fireEvent,
  navigationState,
  render,
  resetHarness,
} from "../settings/project-mcp-connections-panel-test-support";

const STEP_ID = "0198f2c4-0000-7000-8000-000000000003";
const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const step = {
  id: STEP_ID,
  projectId: PROJECT_ID,
  key: "notion-review",
  name: "Review Notion",
  description: null,
  prompt: "Review",
  version: 1,
  kind: "user_defined",
  entrypointJson: null,
  toolCallJson: null,
  environment: null,
  inputSchemaJson: {},
  resultSchemaJson: null,
  errors: [],
  retry: [],
  grants: [],
  maxTurns: null,
  concurrency: null,
  logs: { archive: "always" },
  opencodeMcpJson: null,
  healthChecksJson: null,
  repo: { mode: "readOnly", gitCredentials: "none", baseBranch: null },
  status: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
void mock.module("./step-definition-dialog", () => ({
  StepDefinitionDialog: ({
    open,
    step: selected,
    onClose,
  }: {
    open: boolean;
    step?: StepDefinitionContract;
    onClose: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={selected?.name ?? "New step"}>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

const { StepLibraryTab } = await import("./step-library-tab");

beforeEach(() => {
  resetHarness();
  navigationState.search = `stepDefinitionId=${STEP_ID}`;
  apiState.stepDefinitionsResult = { data: [step], error: null };
});
afterEach(cleanup);

test("usage deep link resolves to the loaded step and can be dismissed", async () => {
  const view = render(<StepLibraryTab projectId={PROJECT_ID} canManage />);
  expect(
    await view.findByRole("dialog", { name: "Review Notion" }),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(view.queryByRole("dialog")).toBeNull();
});

test("a missing linked step reports unavailable rather than opening create", async () => {
  apiState.stepDefinitionsResult = { data: [], error: null };
  const view = render(<StepLibraryTab projectId={PROJECT_ID} canManage />);
  expect(
    await view.findByText("The linked step is no longer available."),
  ).toBeTruthy();
  expect(view.queryByRole("dialog")).toBeNull();
});

const toolStep = {
  ...step,
  id: "0198f2c4-0000-7000-8000-000000000004",
  key: "create-issue",
  name: "Create issue",
  kind: "mcp_tool",
  prompt: null,
  resultSchemaJson: { type: "object" },
  toolCallJson: {
    server: "linear",
    tool: "create_issue",
    argsTemplate: {},
    toolSchemas: { input: { type: "object" }, output: null },
  },
};

test("the kind filter narrows the library to MCP tool steps", async () => {
  navigationState.search = "";
  apiState.stepDefinitionsResult = { data: [step, toolStep], error: null };
  const view = render(<StepLibraryTab projectId={PROJECT_ID} canManage />);
  expect(await view.findByText("Review Notion")).toBeTruthy();
  expect(view.getByText("linear.create_issue")).toBeTruthy();
  expect(view.getByText("MCP tool")).toBeTruthy();

  fireEvent.mouseDown(view.getByRole("combobox"));
  fireEvent.click(await view.findByRole("option", { name: "MCP tool" }));

  expect(view.queryByText("Review Notion")).toBeNull();
  expect(view.getByText("Create issue")).toBeTruthy();
});
