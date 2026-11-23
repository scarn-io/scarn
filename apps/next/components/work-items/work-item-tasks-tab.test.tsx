import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  parseUuidV7,
  type WorkItemConversationContract,
} from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "@/components/tasks/task-api";
import type { WorkItemExecutionsData } from "@/components/executions/use-work-item-executions";
import { installDom } from "@/tests/support/install-dom";

type ApiResult = { data: unknown; error: unknown };

const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
const workItemId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901");
const blockerId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa902");
const runId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa910");
const olderRunId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa911");
const definitionId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa920");

let blocksResult: ApiResult = {
  data: { blockedBy: [], blocking: [] },
  error: null,
};
let blockerResult: ApiResult = { data: null, error: null };

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "work-item-blocks": { get: () => Promise.resolve(blocksResult) },
      "work-items": () => ({ get: () => Promise.resolve(blockerResult) }),
    },
  }),
}));

const { WorkItemTasksTab } = await import("./work-item-tasks-tab");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const buildTask = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
  projectId,
  kind: "agent",
  name: null,
  status: "running",
  createdAt: "2026-10-01T12:00:00.000Z",
  scheduledFor: null,
  updatedAt: "2026-10-01T12:00:00.000Z",
  waitingOnYou: false,
  waitingOn: [],
  conversationId: null,
  workItem: { id: workItemId, platformKey: "GH-12", title: "Fix the bug" },
  repoConversation: null,
  startedBy: { kind: "system" },
  source: {
    kind: "step_definition",
    stepDefinitionId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa600"),
    key: "implement",
    name: "Implement",
    version: 3,
  },
  pipelineRunId: null,
  nodeId: null,
  pipelineRun: null,
  runNumber: 1,
  durationMs: null,
  latest: null,
  ...overrides,
});

const noExecutions: Pick<
  WorkItemExecutionsData,
  "executions" | "definitionsById"
> = { executions: [], definitionsById: new Map() };

const renderTab = (
  tasks: TaskSummary[],
  {
    conversations = [],
    executions = noExecutions,
  }: {
    conversations?: WorkItemConversationContract[];
    executions?: Pick<WorkItemExecutionsData, "executions" | "definitionsById">;
  } = {},
) =>
  render(
    <ProjectRouteProvider
      username="alice"
      projectSlug="demo"
      projectId={projectId}
      isMember
      permissions={[]}
    >
      <WorkItemTasksTab
        workItemId={workItemId}
        tasks={tasks}
        loading={false}
        error=""
        conversations={conversations}
        executions={executions}
      />
    </ProjectRouteProvider>,
  );

describe("WorkItemTasksTab", () => {
  beforeEach(() => {
    installDom();
    blocksResult = { data: { blockedBy: [], blocking: [] }, error: null };
    blockerResult = { data: null, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  test("says so when the item has no Tasks", () => {
    const view = renderTab([]);

    expect(view.getByText("No tasks on this work item yet.")).toBeTruthy();
  });

  test("each row links to its Task's run page", () => {
    const view = renderTab([buildTask()]);

    expect(view.getByTestId("task-row").getAttribute("href")).toBe(
      "/alice/demo/runs/tasks/019e9a92-b432-73e8-9341-3519156fa801",
    );
    expect(view.getByText("Implement")).toBeTruthy();
  });

  test("the caption names the kind, the pipeline run, the messages and the duration", () => {
    const conversationId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa930");
    const view = renderTab(
      [
        buildTask({
          status: "succeeded",
          durationMs: 125_000,
          pipelineRunId: runId,
          conversationId,
        }),
      ],
      {
        conversations: [
          {
            id: conversationId,
            messages: [{}, {}, {}],
          } as unknown as WorkItemConversationContract,
        ],
        executions: {
          executions: [
            { id: runId, pipelineDefinitionId: definitionId },
            { id: olderRunId, pipelineDefinitionId: definitionId },
          ] as unknown as WorkItemExecutionsData["executions"],
          definitionsById: new Map([
            [definitionId, { name: "Triage" }],
          ]) as unknown as WorkItemExecutionsData["definitionsById"],
        },
      },
    );

    expect(
      view.getByText(/^Agent · Triage #2 · 3 messages · 2m 5s · updated/),
    ).toBeTruthy();
  });

  test("a code Task waiting for work shows no duration and the blocker it waits on", async () => {
    blocksResult = {
      data: { blockedBy: [{ blockingWorkItemId: blockerId }], blocking: [] },
      error: null,
    };
    blockerResult = {
      data: { id: blockerId, title: "Ship the API", state: "open" },
      error: null,
    };
    const view = renderTab([
      buildTask({ kind: "code", status: "waiting_for_work" }),
    ]);

    expect(view.getByText(/^Code step · updated/)).toBeTruthy();
    await waitFor(() => {
      expect(
        view.getByText("Will start when Ship the API closes"),
      ).toBeTruthy();
    });
  });

  test("a Task waiting for a concurrency slot says what it waits for", () => {
    const view = renderTab([
      buildTask({ status: "waiting_for_concurrency_slot" }),
    ]);

    expect(view.getByText("Waiting for slot")).toBeTruthy();
    expect(
      view.getByText(
        "Will start when another task of its step on this item ends",
      ),
    ).toBeTruthy();
  });

  test("a failed Task shows its error from the summary", () => {
    const view = renderTab([
      buildTask({
        status: "failed",
        latest: { kind: "error", text: "Tests failed" },
      }),
    ]);

    expect(view.getByTestId("task-error").textContent).toBe("Tests failed");
  });

  test("a failed Task without a readable error says Failed", () => {
    const view = renderTab([buildTask({ status: "failed" })]);

    expect(view.getByTestId("task-error").textContent).toBe("Failed");
  });
});
