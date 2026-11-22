/**
 * The pre-Runs project routes are server pages that only `redirect()`; each
 * one lands on its Runs equivalent.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

class RedirectSignal extends Error {
  constructor(readonly href: string) {
    super(`redirect ${href}`);
  }
}

const state = {
  task: null as { pipelineRunId: string | null; nodeId: string | null } | null,
  taskReads: [] as string[],
  conversation: null as { taskId?: string } | null,
  conversationReads: [] as string[],
};

class NotFoundSignal extends Error {}

void mock.module("next/navigation", () => ({
  redirect: (href: string) => {
    throw new RedirectSignal(href);
  },
  notFound: () => {
    throw new NotFoundSignal("notFound");
  },
}));

void mock.module("@/app/_lib/scarn-api-client", () => ({
  getScarnApiRequestHeaders: () => Promise.resolve({ cookie: "session" }),
  getScarnApiClient: () =>
    Promise.resolve({
      api: {
        tasks: ({ taskId }: { taskId: string }) => ({
          get: () => {
            state.taskReads.push(taskId);
            return Promise.resolve(
              state.task
                ? { data: state.task, error: null }
                : { data: null, error: { status: 404 } },
            );
          },
        }),
        conversations: ({ conversationId }: { conversationId: string }) => ({
          get: () => {
            state.conversationReads.push(conversationId);
            return Promise.resolve(
              state.conversation
                ? { data: state.conversation, error: null }
                : { data: null, error: { status: 404 } },
            );
          },
        }),
      },
    }),
}));

const pipelineId = "019e9a92-b432-73e8-9341-3519156fa900";
const runId = "019e9a92-b432-73e8-9341-3519156fa901";
const taskId = "019e9a92-b432-73e8-9341-3519156fa902";
const chatId = "019e9a92-b432-73e8-9341-3519156fa903";
const project = { username: "alice", projectSlug: "demo" };

const pages = {
  executions: (await import("@/app/[username]/[projectSlug]/executions/page"))
    .default,
  execution: (
    await import("@/app/[username]/[projectSlug]/executions/[executionId]/page")
  ).default,
  tasks: (await import("@/app/[username]/[projectSlug]/(content)/tasks/page"))
    .default,
  task: (
    await import("@/app/[username]/[projectSlug]/(content)/tasks/[taskId]/page")
  ).default,
  conversations: (
    await import("@/app/[username]/[projectSlug]/conversations/page")
  ).default,
  newConversation: (
    await import("@/app/[username]/[projectSlug]/conversations/new/page")
  ).default,
  conversation: (
    await import("@/app/[username]/[projectSlug]/conversations/[conversationId]/page")
  ).default,
  runChat: (
    await import("@/app/[username]/[projectSlug]/runs/chats/[conversationId]/page")
  ).default,
};

const isNotFound = async (render: () => Promise<unknown>): Promise<boolean> => {
  try {
    await render();
  } catch (error) {
    if (error instanceof NotFoundSignal) return true;
    throw error;
  }
  return false;
};

const redirectOf = async (render: () => Promise<unknown>): Promise<string> => {
  try {
    await render();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.href;
    throw error;
  }
  throw new Error("page did not redirect");
};

describe("legacy run redirect pages", () => {
  beforeEach(() => {
    state.task = null;
    state.taskReads = [];
    state.conversation = null;
    state.conversationReads = [];
  });

  test("executions → runs?whatRan&status", async () => {
    expect(
      await redirectOf(() =>
        pages.executions({
          params: Promise.resolve(project),
          searchParams: Promise.resolve({ pipelineId, status: "failed" }),
        }),
      ),
    ).toBe(`/alice/demo/runs?status=failed&whatRan=${pipelineId}`);
  });

  test("executions/[id] → runs/[id], keeping the run page's params", async () => {
    expect(
      await redirectOf(() =>
        pages.execution({
          params: Promise.resolve({ ...project, executionId: runId }),
          searchParams: Promise.resolve({ step: "review", view: "logs" }),
        }),
      ),
    ).toBe(`/alice/demo/runs/${runId}?step=review&view=logs`);
  });

  test("tasks?preset=needs_attention → runs?status=needs-you", async () => {
    expect(
      await redirectOf(() =>
        pages.tasks({
          params: Promise.resolve(project),
          searchParams: Promise.resolve({ preset: "needs_attention" }),
        }),
      ),
    ).toBe("/alice/demo/runs?status=needs-you");
  });

  test("tasks/[id] of a step → the owning pipeline run on that step", async () => {
    state.task = { pipelineRunId: runId, nodeId: "review" };
    expect(
      await redirectOf(() =>
        pages.task({ params: Promise.resolve({ ...project, taskId }) }),
      ),
    ).toBe(`/alice/demo/runs/${runId}?step=review`);
    expect(state.taskReads).toEqual([taskId]);
  });

  test("tasks/[id] of a standalone Task → runs/tasks/[id]", async () => {
    state.task = { pipelineRunId: null, nodeId: null };
    expect(
      await redirectOf(() =>
        pages.task({ params: Promise.resolve({ ...project, taskId }) }),
      ),
    ).toBe(`/alice/demo/runs/tasks/${taskId}`);
  });

  test("tasks/[id] that can't be read → runs/tasks/[id]", async () => {
    expect(
      await redirectOf(() =>
        pages.task({ params: Promise.resolve({ ...project, taskId }) }),
      ),
    ).toBe(`/alice/demo/runs/tasks/${taskId}`);
  });

  test("tasks/[id] with a junk id skips the lookup", async () => {
    expect(
      await redirectOf(() =>
        pages.task({
          params: Promise.resolve({ ...project, taskId: "nope" }),
        }),
      ),
    ).toBe("/alice/demo/runs/tasks/nope");
    expect(state.taskReads).toEqual([]);
  });

  test("conversations → runs?whatRan=task", async () => {
    expect(
      await redirectOf(() =>
        pages.conversations({ params: Promise.resolve(project) }),
      ),
    ).toBe("/alice/demo/runs?whatRan=task");
  });

  test("conversations/new → runs?whatRan=task&compose=1", async () => {
    expect(
      await redirectOf(() =>
        pages.newConversation({ params: Promise.resolve(project) }),
      ),
    ).toBe("/alice/demo/runs?whatRan=task&compose=1");
  });

  for (const [name, page] of [
    ["conversations/[id]", pages.conversation],
    ["runs/chats/[id]", pages.runChat],
  ] as const) {
    test(`${name} → the chat's Task page`, async () => {
      state.conversation = { taskId };
      expect(
        await redirectOf(() =>
          page({
            params: Promise.resolve({ ...project, conversationId: chatId }),
          }),
        ),
      ).toBe(`/alice/demo/runs/tasks/${taskId}`);
      expect(state.conversationReads).toEqual([chatId]);
    });

    test(`${name} that can't be read → 404`, async () => {
      expect(
        await isNotFound(() =>
          page({
            params: Promise.resolve({ ...project, conversationId: chatId }),
          }),
        ),
      ).toBe(true);
    });

    test(`${name} with a junk id → 404 without a lookup`, async () => {
      expect(
        await isNotFound(() =>
          page({
            params: Promise.resolve({ ...project, conversationId: "nope" }),
          }),
        ),
      ).toBe(true);
      expect(state.conversationReads).toEqual([]);
    });
  }
});
