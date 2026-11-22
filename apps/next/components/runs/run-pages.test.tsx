/**
 * A Task's run page opens on its Task view, except a Task without a work item
 * that answers a conversation (a chat): that one opens on its conversation.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildTask,
  projectId,
  withProjectRoute,
} from "@/components/tasks/tasks-test-support";
import type { TaskSummary } from "@/components/tasks/task-api";
import { buildRun, id, viewerId } from "./runs-list-fixtures";

const taskId = id("801");
const conversationId = id("802");

const state = { task: null as TaskSummary | null };

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => `/alice/demo/runs/tasks/${taskId}`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
}));

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: viewerId } } }) },
}));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        runs: () => () => ({
          get: () =>
            Promise.resolve({
              data: buildRun({ type: "task", id: taskId }),
              error: null,
            }),
        }),
      }),
      tasks: () => ({
        get: () => Promise.resolve({ data: state.task, error: null }),
      }),
    },
  }),
}));

void mock.module("@/components/tasks/task-view", () => ({
  TaskView: ({ taskId: shown }: { taskId: string }) => (
    <div data-testid="task-view">{shown}</div>
  ),
}));

void mock.module(
  "@/components/repo-conversations/repo-conversation-view",
  () => ({
    RepoConversationView: ({
      conversationId: shown,
      framed,
    }: {
      conversationId: string;
      framed?: boolean;
    }) => (
      <div data-testid="repo-conversation-view" data-framed={String(framed)}>
        {shown}
      </div>
    ),
  }),
);

const { act, cleanup, render } = await import("@testing-library/react");
const { RunTaskPage } = await import("./run-pages");

const renderPage = async () =>
  await act(async () =>
    render(
      await withProjectRoute(
        <RunTaskPage projectId={projectId} taskId={taskId} />,
      ),
    ),
  );

describe("RunTaskPage", () => {
  beforeEach(() => {
    state.task = null;
  });

  afterEach(() => {
    cleanup();
  });

  test("a Task with a work item opens on its Task view", async () => {
    state.task = buildTask({ id: taskId });
    const view = await renderPage();

    expect((await view.findByTestId("task-view")).textContent).toBe(taskId);
    expect(view.queryByTestId("repo-conversation-view")).toBeNull();
  });

  test("a Task without a work item opens on its conversation, framed", async () => {
    state.task = buildTask({
      id: taskId,
      workItem: null,
      repoConversation: { id: conversationId, title: "Where is auth?" },
    });
    const view = await renderPage();

    const pane = await view.findByTestId("repo-conversation-view");
    expect(pane.textContent).toBe(conversationId);
    expect(pane.getAttribute("data-framed")).toBe("true");
    expect(view.queryByTestId("task-view")).toBeNull();
  });
});
