import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  parseUuidV7,
  type WorkItemConversationContract,
  type WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "@/components/tasks/task-api";
import { installDom } from "@/tests/support/install-dom";

type ApiResult = { data: unknown; error: unknown };

const projectId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900");
const workItemId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901");
const conversationId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa930");
const runId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa910");

const ok: ApiResult = { data: {}, error: null };
type RecordedBody = Record<string, string> | undefined;
const calls: { path: string; body: RecordedBody }[] = [];
const record = (path: string) => (body?: RecordedBody) => {
  calls.push({ path, body });
  return Promise.resolve(ok);
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      conversations: ({ conversationId: id }: { conversationId: string }) => ({
        messages: { post: record(`conversations/${id}/messages`) },
        done: { post: record(`conversations/${id}/done`) },
        continue: { post: record(`conversations/${id}/continue`) },
      }),
      tasks: ({ taskId }: { taskId: string }) => ({
        cancel: { post: record(`tasks/${taskId}/cancel`) },
      }),
      "pipeline-executions": ({
        pipelineExecutionId,
      }: {
        pipelineExecutionId: string;
      }) => ({
        questions: ({ questionId }: { questionId: string }) => ({
          answer: {
            post: record(
              `pipeline-executions/${pipelineExecutionId}/questions/${questionId}/answer`,
            ),
          },
          continue: {
            post: record(
              `pipeline-executions/${pipelineExecutionId}/questions/${questionId}/continue`,
            ),
          },
        }),
      }),
    },
  }),
}));

const pushes: { href: string; options?: { scroll?: boolean } }[] = [];
void mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string, options?: { scroll?: boolean }) => {
      pushes.push({ href, options });
    },
    replace: () => {},
    back: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/alice/demo/work-items/GH-12",
  useSearchParams: () => new URLSearchParams(),
}));

installDom();
Object.assign(globalThis, {
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(Date.now());
    }, 0),
  cancelAnimationFrame: (id: number) => {
    clearTimeout(id);
  },
});
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { WorkItemAgentsPanel } = await import("./work-item-agents-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");
const { useConversationParam } = await import("./use-conversation-param");

const buildTask = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa801"),
  projectId,
  kind: "agent",
  name: "Grill the spec",
  status: "running",
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
  waitingOnYou: false,
  waitingOn: [],
  conversationId: null,
  workItem: { id: workItemId, platformKey: "GH-12", title: "Fix the bug" },
  repoConversation: null,
  startedBy: { kind: "system" },
  source: { kind: "prompt", promptPreview: "Grill it" },
  pipelineRunId: null,
  nodeId: null,
  pipelineRun: null,
  runNumber: 1,
  durationMs: null,
  latest: null,
  ...overrides,
});

const waitingConversation = {
  id: conversationId,
  status: "waiting_for_person",
  messages: [
    {
      id: "m1",
      authorKind: "agent",
      authorName: null,
      taskRunId: null,
      body: "Earlier question",
      createdAt: "2026-10-01T12:00:00.000Z",
    },
    {
      id: "m2",
      authorKind: "person",
      authorName: "alice",
      taskRunId: null,
      body: "Earlier answer",
      createdAt: "2026-10-01T12:01:00.000Z",
    },
    {
      id: "m3",
      authorKind: "agent",
      authorName: null,
      taskRunId: null,
      body: "Which database should I use?",
      createdAt: "2026-10-01T12:02:00.000Z",
    },
  ],
} as unknown as WorkItemConversationContract;

const waitingTask = (overrides: Partial<TaskSummary> = {}) =>
  buildTask({
    status: "waiting_for_person",
    conversationId,
    waitingOnYou: true,
    ...overrides,
  });

const openQuestion = {
  questionId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa940"),
  commentId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa941"),
  visitId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa942"),
  pipelineExecutionId: runId,
  status: "open",
  body: "Ship to staging first?",
  askedAt: "2026-10-01T12:00:00.000Z",
  waitingOnYou: false,
  waitingOn: [{ userId: "u-2", username: "dwight" }],
} as unknown as WorkItemQuestionContract;

const allPermissions = ["comments:create", "executions:write"];

type PanelProps = {
  tasks?: TaskSummary[];
  conversations?: WorkItemConversationContract[];
  questions?: WorkItemQuestionContract[];
  onChanged?: () => void;
};

function PanelWithSheetParam(props: PanelProps) {
  const conversationParam = useConversationParam();
  return (
    <WorkItemAgentsPanel
      tasks={props.tasks ?? []}
      conversations={props.conversations ?? []}
      questions={props.questions ?? []}
      decisionWaits={[]}
      viewerUsername="alice"
      onOpenConversation={conversationParam.open}
      onChanged={props.onChanged ?? (() => {})}
    />
  );
}

const renderPanel = (
  props: PanelProps,
  { isMember = true, permissions = allPermissions } = {},
) =>
  render(
    <ProjectRouteProvider
      username="alice"
      projectSlug="demo"
      projectId={projectId}
      isMember={isMember}
      permissions={permissions}
    >
      <PanelWithSheetParam {...props} />
    </ProjectRouteProvider>,
  );

describe("WorkItemAgentsPanel", () => {
  beforeEach(() => {
    calls.length = 0;
    pushes.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("renders nothing when nothing is live", () => {
    const view = renderPanel({});

    expect(view.queryByRole("region", { name: "Agents on this" })).toBeNull();
  });

  test("counts its rows and how many wait on the viewer", () => {
    const view = renderPanel({
      tasks: [
        waitingTask(),
        buildTask({ id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802") }),
      ],
      conversations: [waitingConversation],
      questions: [openQuestion],
    });

    expect(view.getByText("Agents on this (3)")).toBeTruthy();
    expect(view.getByText("1 waiting on you")).toBeTruthy();
  });

  test("a running Task shows its latest output and links to its run", () => {
    const view = renderPanel({
      tasks: [
        buildTask({ latest: { kind: "log", text: "Running the test suite" } }),
      ],
    });

    expect(view.getByTestId("last-log-line").textContent).toBe(
      "Running the test suite",
    );
    expect(
      view.getByRole("link", { name: "Open run" }).getAttribute("href"),
    ).toBe("/alice/demo/runs/tasks/019e9a92-b432-73e8-9341-3519156fa801");
  });

  test("a conversation Task is a summary row that previews the agent's latest message and opens the sheet", () => {
    const view = renderPanel({
      tasks: [waitingTask()],
      conversations: [waitingConversation],
    });

    expect(view.getByTestId("conversation-preview").textContent).toBe(
      "Which database should I use?",
    );
    expect(view.getByText("You")).toBeTruthy();
    expect(view.getByText("Reply")).toBeTruthy();
    expect(view.queryByText("Earlier answer")).toBeNull();

    fireEvent.click(
      view.getByRole("button", {
        name: "Open conversation with Grill the spec",
      }),
    );

    expect(pushes).toEqual([
      {
        href: `/alice/demo/work-items/GH-12?conversation=${conversationId}`,
        options: { scroll: false },
      },
    ]);
  });

  test("the preview marks the viewer's own reply, and says Thinking while the agent works", () => {
    const answered = {
      ...waitingConversation,
      status: "agent_turn",
      messages: waitingConversation.messages.slice(0, 2),
    } as unknown as WorkItemConversationContract;
    const replied = renderPanel({
      tasks: [buildTask({ conversationId })],
      conversations: [{ ...answered, status: "closed" }],
    });
    expect(replied.getByTestId("conversation-preview").textContent).toBe(
      "You: Earlier answer",
    );
    expect(replied.getByText("Open")).toBeTruthy();
    cleanup();

    const thinking = renderPanel({
      tasks: [buildTask({ conversationId })],
      conversations: [answered],
    });
    expect(thinking.getByTestId("conversation-preview").textContent).toBe(
      "Thinking…",
    );
  });

  test("a conversation row has no reply box, question, Stop or Open run", () => {
    const view = renderPanel({
      tasks: [waitingTask()],
      conversations: [waitingConversation],
    });

    expect(view.queryByTestId("panel-question")).toBeNull();
    expect(view.queryByLabelText("Reply to Grill the spec…")).toBeNull();
    expect(view.queryByRole("button", { name: "Reply" })).toBeNull();
    expect(view.queryByRole("button", { name: "Done" })).toBeNull();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByRole("link", { name: "Open run" })).toBeNull();
  });

  test("Stop cancels an agent or MCP tool Task; a code Task has no Stop", async () => {
    const view = renderPanel({ tasks: [buildTask()] });

    fireEvent.click(view.getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(calls).toEqual([
        {
          path: "tasks/019e9a92-b432-73e8-9341-3519156fa801/cancel",
          body: undefined,
        },
      ]);
    });
    cleanup();

    const mcpTool = renderPanel({ tasks: [buildTask({ kind: "mcp_tool" })] });
    expect(mcpTool.getByRole("button", { name: "Stop" })).toBeTruthy();
    cleanup();

    const code = renderPanel({ tasks: [buildTask({ kind: "code" })] });
    expect(code.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("a non-member can still open a conversation but can't Stop a Task", () => {
    const view = renderPanel(
      {
        tasks: [
          waitingTask(),
          buildTask({
            id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa802"),
          }),
        ],
        conversations: [waitingConversation],
      },
      { isMember: false },
    );

    expect(
      view.getByRole("button", {
        name: "Open conversation with Grill the spec",
      }),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  test("a pipeline question says who it waits on and answers through the run", async () => {
    const view = renderPanel({ questions: [openQuestion] });

    expect(
      view.getByText("Waiting on dwight — you can still reply"),
    ).toBeTruthy();
    fireEvent.change(view.getByLabelText("Answer the question…"), {
      target: { value: "Yes" },
    });
    fireEvent.click(view.getByRole("button", { name: "Reply" }));

    await waitFor(() => {
      expect(calls).toEqual([
        {
          path: `pipeline-executions/${runId}/questions/${openQuestion.questionId}/answer`,
          body: { body: "Yes" },
        },
      ]);
    });
  });
});
