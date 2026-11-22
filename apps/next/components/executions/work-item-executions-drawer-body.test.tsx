import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  PipelineDefinitionContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import type { WorkItemExecutionsData } from "./use-work-item-executions";
import { installDom } from "@/tests/support/install-dom";

let postedExecutionBody: Record<string, unknown> | null = null;

const postExecutionMock = mock((body: Record<string, unknown>) => {
  postedExecutionBody = body;
  return Promise.resolve({ data: null });
});
const refreshMock = mock(async () => {});

const definitions = [
  {
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe101",
    projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
    key: "quality-gate",
    name: "Quality Gate",
    description: "Quality gate definition",
    status: "active",
    archivedAt: null,
    inputSchemaJson: null,
    stepDefinitions: [],
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
  },
] as unknown as PipelineDefinitionContract[];

const workItem = {
  id: "01966a2c-9494-7db5-aa46-0f8f5cbbe111",
  projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
  platform: "linear",
  platformId: "VOC-123",
  platformKey: "VOC-123",
  url: "https://example.com/issues/VOC-123",
  title: "Improve pipeline controls",
  description: "Need work-item pipeline execution controls.",
  sourceCreatedAt: "2026-04-26T12:00:00.000Z",
  sourceUpdatedAt: "2026-04-26T12:00:00.000Z",
  fields: {
    repository: "github.com/acme/repo",
    baseBranch: "main",
  },
  createdAt: "2026-04-26T12:00:00.000Z",
  updatedAt: "2026-04-26T12:00:00.000Z",
} as unknown as WorkItemContract;

const executionsData: WorkItemExecutionsData = {
  definitions,
  executions: [],
  definitionsById: new Map(
    definitions.map((definition) => [definition.id, definition]),
  ),
  total: 0,
  loading: false,
  error: "",
  refresh: refreshMock,
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "pipeline-executions": {
        post: postExecutionMock,
      },
    },
  }),
}));

const { NewExecutionButton } =
  await import("./work-item-executions-drawer-body");

describe("NewExecutionButton", () => {
  beforeEach(() => {
    postExecutionMock.mockClear();
    refreshMock.mockClear();
    postedExecutionBody = null;

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

  test("creates a pipeline execution without synthesized inputJson", async () => {
    const view = render(
      <NewExecutionButton
        projectId="01966a2c-9494-7db5-aa46-0f8f5cbbe001"
        workItem={workItem}
        data={executionsData}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "New" }));
    fireEvent.click(await view.findByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postExecutionMock).toHaveBeenCalledTimes(1);
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });

    expect(postedExecutionBody).toMatchObject({
      projectId: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
      workItemId: workItem.id,
      pipelineDefinitionId: "01966a2c-9494-7db5-aa46-0f8f5cbbe101",
    });
    expect(postedExecutionBody).not.toHaveProperty("inputJson");
  });
});
