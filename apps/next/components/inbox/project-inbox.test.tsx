import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "@/components/tasks/task-api";
import type { InboxSummary, InboxWait, InboxWorkItem } from "./inbox-api";

const { buildTask, projectId, withProjectRoute, workItemId } =
  await import("@/components/tasks/tasks-test-support");

type Body = Record<string, unknown> | undefined;

const state = {
  waitingTasks: [] as TaskSummary[],
  failedTasks: [] as TaskSummary[],
  waits: [] as InboxWait[],
  workItems: [] as InboxWorkItem[],
  summary: null as InboxSummary | null,
  notifications: [] as UserNotificationContract[],
  taskQueries: [] as Record<string, unknown>[],
  posts: [] as { path: string; body: Body }[],
};
const record = (path: string) => (body?: Body) => {
  state.posts.push({ path, body });
  return Promise.resolve({ data: {}, error: null });
};
const page = (tasks: TaskSummary[]) => ({
  data: { tasks, nextCursor: null, counts: {} },
  error: null,
});

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        tasks: {
          get: ({ query }: { query: Record<string, unknown> }) => {
            state.taskQueries.push(query);
            return Promise.resolve(
              page(
                query["waitingOnMe"] ? state.waitingTasks : state.failedTasks,
              ),
            );
          },
        },
        inbox: {
          waits: {
            get: () =>
              Promise.resolve({
                data: { waits: state.waits, workItems: state.workItems },
                error: null,
              }),
          },
          summary: {
            get: () => Promise.resolve({ data: state.summary, error: null }),
          },
        },
        notifications: Object.assign(
          () => ({
            get: () =>
              Promise.resolve({ data: { deliveries: [] }, error: null }),
          }),
          {
            get: () =>
              Promise.resolve({ data: state.notifications, error: null }),
          },
        ),
      }),
      conversations: ({ conversationId }: { conversationId: string }) => ({
        messages: { post: record(`conversations/${conversationId}/messages`) },
      }),
      "pipeline-executions": ({
        pipelineExecutionId: id,
      }: {
        pipelineExecutionId: string;
      }) => ({
        questions: ({ questionId }: { questionId: string }) => ({
          answer: {
            post: record(
              `pipeline-executions/${id}/questions/${questionId}/answer`,
            ),
          },
        }),
        visits: ({ visitId }: { visitId: string }) => ({
          decision: {
            post: record(
              `pipeline-executions/${id}/visits/${visitId}/decision`,
            ),
          },
        }),
      }),
    },
  }),
}));

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/alice/demo/inbox",
  useSearchParams: () => new URLSearchParams(),
}));

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { ProjectInbox } = await import("./project-inbox");

Object.defineProperty(document, "hidden", { configurable: true, value: false });

const conversationId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa930");
const runId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa910");
const visitId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa942");
const questionId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa940");
const workItem = { id: workItemId, platformKey: "GH-12", title: "Fix the bug" };
const waitBase = {
  pipelineExecutionId: runId,
  visitId,
  nodeId: "review",
  pipelineName: "Ship it",
  workItem,
  askedAt: "2026-10-01T12:00:00.000Z",
  waitingOn: [],
};
const summary = (overrides: Partial<InboxSummary> = {}): InboxSummary => ({
  waitingOnMe: 0,
  failedStartedByMe: 0,
  pipelineWaitsOnMe: 0,
  workItemsWaitingOnMe: 0,
  badgeCount: 0,
  waitingOnOthers: 0,
  ...overrides,
});

const renderInbox = async () =>
  render(
    await withProjectRoute(
      <ProjectInbox
        projectId={projectId}
        initialNotifications={state.notifications}
        pollIntervalMs={60_000}
      />,
      ["comments:create", "executions:write"],
    ),
  );

describe("ProjectInbox", () => {
  beforeEach(() => {
    state.waitingTasks = [];
    state.failedTasks = [];
    state.waits = [];
    state.workItems = [];
    state.summary = summary();
    state.notifications = [];
    state.taskQueries.length = 0;
    state.posts.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  test("empty: says nothing waits on you, hides the stopped section, keeps notifications", async () => {
    const view = await renderInbox();

    expect(await view.findByText("Nothing is waiting on you")).toBeTruthy();
    expect(view.queryByText("Agent work that stopped")).toBeNull();
    expect(view.queryByText("Work items waiting on you")).toBeNull();
    expect(view.getByText("Other notifications")).toBeTruthy();
    expect(view.queryByText(/waiting on other people/)).toBeNull();
    expect(
      state.taskQueries.some((query) => query["waitingOnMe"] === true),
    ).toBe(true);
    expect(
      state.taskQueries.some(
        (query) =>
          query["status"] === "failed" && query["startedByMe"] === true,
      ),
    ).toBe(true);
  });

  test("a waiting agent shows its last message, links to its conversation sheet and replies to its conversation", async () => {
    state.waitingTasks = [
      buildTask({
        status: "waiting_for_person",
        waitingOnYou: true,
        conversationId,
        latest: { kind: "message", text: "Which database should I use?" },
      }),
    ];
    const view = await renderInbox();

    expect(await view.findByText("Which database should I use?")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Open GH-12" }).getAttribute("href"),
    ).toBe(
      `/alice/demo/work-items/${workItemId}?conversation=${conversationId}`,
    );

    fireEvent.change(view.getByLabelText("Reply to Implement…"), {
      target: { value: " Postgres " },
    });
    fireEvent.click(view.getByRole("button", { name: "Reply" }));

    await waitFor(() => {
      expect(state.posts).toEqual([
        {
          path: `conversations/${conversationId}/messages`,
          body: { body: "Postgres" },
        },
      ]);
    });
  });

  test("a waiting agent without a conversation links to the agents panel", async () => {
    state.waitingTasks = [
      buildTask({
        status: "waiting_for_person",
        waitingOnYou: true,
        latest: { kind: "message", text: "Which database should I use?" },
      }),
    ];
    const view = await renderInbox();

    expect(await view.findByText("Which database should I use?")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Open GH-12" }).getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${workItemId}#agents`);
    expect(view.queryByLabelText("Reply to Implement…")).toBeNull();
  });

  test("a pipeline question answers through its run", async () => {
    state.waits = [
      {
        ...waitBase,
        kind: "reply",
        questionId,
        commentId: questionId,
        body: "Ship to staging first?",
      },
    ];
    const view = await renderInbox();

    expect(await view.findByText("Ship to staging first?")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Answer the question…"), {
      target: { value: "Yes" },
    });
    fireEvent.click(view.getByRole("button", { name: "Reply" }));

    await waitFor(() => {
      expect(state.posts).toEqual([
        {
          path: `pipeline-executions/${runId}/questions/${questionId}/answer`,
          body: { body: "Yes" },
        },
      ]);
    });
  });

  test("a decision wait posts the chosen action with its note", async () => {
    state.waits = [
      {
        ...waitBase,
        kind: "decision",
        title: "Approve the release",
        actions: [
          { key: "reject", label: "Reject", body: "required" },
          { key: "approve", label: "Approve", body: "optional" },
        ],
      },
    ];
    const view = await renderInbox();

    expect(await view.findByText("Approve the release")).toBeTruthy();
    expect(
      view.getByRole("button", { name: "Reject" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.change(view.getByLabelText("Decision note"), {
      target: { value: "Looks good" },
    });
    fireEvent.click(view.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(state.posts).toEqual([
        {
          path: `pipeline-executions/${runId}/visits/${visitId}/decision`,
          body: { action: "approve", body: "Looks good" },
        },
      ]);
    });
  });

  test("a work item waiting on you shows its title, labels, parent and age, linking to the item", async () => {
    const parentId = parseUuidV7("019e9a92-b432-73e8-9341-3519156fa950");
    state.workItems = [
      {
        id: workItemId,
        platformKey: "manual-1",
        title: "Sign up for Stripe",
        labels: ["wayfinder:task"],
        parent: { id: parentId, title: "Take payments" },
        waitingSince: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        waitingOn: [],
      },
    ];
    const view = await renderInbox();

    const section = await view.findByRole("region", {
      name: "Work items waiting on you",
    });
    const row = within(section).getByTestId("inbox-work-item-row");
    expect(
      within(row)
        .getByRole("link", { name: "Sign up for Stripe" })
        .getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${workItemId}`);
    expect(within(row).getByText("wayfinder:task")).toBeTruthy();
    expect(
      within(row)
        .getByRole("link", { name: "Take payments" })
        .getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${parentId}`);
    expect(within(row).getByText(/ready 2 hours ago/)).toBeTruthy();
  });

  test("a failed Task shows its error and links to the item's Tasks tab", async () => {
    state.failedTasks = [
      buildTask({
        status: "failed",
        latest: { kind: "error", text: "Worker crashed" },
      }),
    ];
    const view = await renderInbox();

    expect(await view.findByText("Agent work that stopped")).toBeTruthy();
    expect(view.getByText("Worker crashed")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Open GH-12" }).getAttribute("href"),
    ).toBe(`/alice/demo/work-items/${workItemId}?tab=tasks`);
  });

  test("a waiting Task with no work item shows its question as the title and opens its Task page", async () => {
    state.waitingTasks = [
      buildTask({
        status: "waiting_for_person",
        waitingOnYou: true,
        conversationId,
        workItem: null,
        repoConversation: {
          id: conversationId,
          title: "How does checkout work?",
        },
        source: { kind: "prompt", promptPreview: "You answer questions" },
        latest: { kind: "message", text: "Through the cart service." },
      }),
    ];
    const view = await renderInbox();

    expect(await view.findByText("Through the cart service.")).toBeTruthy();
    expect(view.getByText("How does checkout work?")).toBeTruthy();
    expect(view.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      `/alice/demo/runs/tasks/019e9a92-b432-73e8-9341-3519156fa801`,
    );
    expect(view.queryByRole("link", { name: /Open GH/ })).toBeNull();
  });

  test("a failed Task with no work item opens its Task page", async () => {
    state.failedTasks = [
      buildTask({
        status: "failed",
        conversationId,
        workItem: null,
        repoConversation: { id: conversationId, title: "Where is auth?" },
        latest: { kind: "error", text: "Worker crashed" },
      }),
    ];
    const view = await renderInbox();

    expect(await view.findByText("Where is auth?")).toBeTruthy();
    expect(view.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      `/alice/demo/runs/tasks/019e9a92-b432-73e8-9341-3519156fa801`,
    );
  });

  test("the Tasks it lists leave out ended chats", async () => {
    await renderInbox();

    await waitFor(() => {
      expect(state.taskQueries.length).toBeGreaterThanOrEqual(2);
    });
    expect(
      state.taskQueries.every((query) => query["excludeEndedChats"] === true),
    ).toBe(true);
  });

  test("the footnote links to the Tasks tab's Needs attention preset", async () => {
    state.summary = summary({ waitingOnOthers: 2 });
    const view = await renderInbox();

    const link = await view.findByRole("link", {
      name: "2 agents are waiting on other people",
    });
    expect(link.getAttribute("href")).toBe("/alice/demo/runs?status=needs-you");
  });

  test("a repo conversation notification links to its Task", async () => {
    state.notifications = [
      {
        id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa960"),
        projectId,
        workItemId: null,
        pipelineExecutionId: null,
        taskId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa961"),
        agentSessionId: null,
        recipientUserId: null,
        kind: "result_ready",
        audience: "specific_users",
        title: "Repo conversation answer ready",
        body: "Open the conversation to read the answer.",
        priority: "normal",
        source: "system",
        status: "delivered",
        payloadJson: { conversationId },
        createdAt: "2026-10-01T12:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      },
    ];
    const view = await renderInbox();

    expect(
      await view.findByText("Repo conversation answer ready"),
    ).toBeTruthy();
    expect(view.getByRole("link", { name: "Task" }).getAttribute("href")).toBe(
      `/alice/demo/conversations/${conversationId}`,
    );
  });
});
