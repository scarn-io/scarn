import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  buildChat as chat,
  CHAT_COMMIT as COMMIT,
  CHAT_RUN_ID as RUN_ID,
  conversationId,
  failWith,
  projectId,
  resetApi,
  serveConversation as serve,
  setDocumentHidden as setHidden,
  withProjectRoute,
} from "./repo-conversations-test-support";
import type { RepoConversation } from "./repo-conversation-api";

const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { RepoConversationView, DELETE_CONFIRMATION_TEXT } =
  await import("./repo-conversation-view");

const renderView = async (
  pollIntervalsMs: { active: number; idle: number } = {
    active: 60_000,
    idle: 60_000,
  },
  framed = false,
) =>
  render(
    await withProjectRoute(
      <RepoConversationView
        conversationId={conversationId}
        projectId={projectId}
        pollIntervalsMs={pollIntervalsMs}
        framed={framed}
      />,
      ["comments:write", "executions:write"],
    ),
  );

type View = Awaited<ReturnType<typeof renderView>>;

const loaded = async (view: View) => {
  await waitFor(() => {
    expect(view.getByText("In the auth middleware.")).toBeTruthy();
  });
};

describe("RepoConversationView", () => {
  beforeEach(() => {
    resetApi();
    setHidden(false);
  });

  afterEach(() => {
    cleanup();
  });

  describe("states", () => {
    const working: [RepoConversation["state"], string, string][] = [
      ["queued", "Queued", "Queued — waiting for a worker to pick it up."],
      ["running", "Working", "Scarn is working…"],
      ["retry_queued", "Retry queued", "Retry queued — waiting for a worker."],
    ];
    for (const [state, chip, line] of working) {
      test(`${String(state)}: shows ${chip} and closes the reply box while the agent works`, async () => {
        serve(chat({ state }));
        const view = await renderView();
        await loaded(view);

        expect(view.getAllByText(chip).length).toBeGreaterThan(0);
        expect(view.getByText(line)).toBeTruthy();
        expect(view.queryByLabelText("Message Scarn")).toBeNull();
        expect(view.getByTestId("chat-reply-blocked").textContent).toBe(
          "The agent is working…",
        );
      });
    }

    test("waiting: the reply box is open", async () => {
      serve(chat({ state: "waiting" }));
      const view = await renderView();
      await loaded(view);

      expect(view.getAllByText("Waiting for a reply").length).toBeGreaterThan(
        0,
      );
      expect(view.getByLabelText("Message Scarn")).toBeTruthy();
      expect(view.queryByTestId("chat-reply-blocked")).toBeNull();
    });

    test("waiting without canReply: says only members can reply", async () => {
      serve(
        chat({
          state: "waiting",
          capabilities: {
            canReply: false,
            canRetry: false,
            canEnd: false,
            canDelete: false,
          },
        }),
      );
      const view = await renderView();
      await loaded(view);

      expect(view.queryByLabelText("Message Scarn")).toBeNull();
      expect(view.getByText("Only project members can reply")).toBeTruthy();
      expect(view.queryByRole("button", { name: "End" })).toBeNull();
      expect(view.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    test("failed with canRetry: shows the reason and a Retry button", async () => {
      serve(
        chat({
          state: "failed",
          latestRun: { id: RUN_ID, status: "failed", reason: "initial" },
          error: {
            code: "COMMIT_MISSING",
            message: "The pinned commit is gone.",
          },
        }),
      );
      const view = await renderView();
      await loaded(view);

      const failure = view.getByTestId("chat-failure");
      expect(
        within(failure).getByText("The pinned commit is gone."),
      ).toBeTruthy();
      expect(
        within(failure).getByRole("button", { name: "Retry" }),
      ).toBeTruthy();
      expect(view.getByText("Retry to continue")).toBeTruthy();
      expect(view.queryByLabelText("Message Scarn")).toBeNull();
    });

    test("failed without canRetry: says an execution manager can retry", async () => {
      serve(
        chat({
          state: "failed",
          error: { code: "X", message: "The worker stopped." },
          capabilities: {
            canReply: true,
            canRetry: false,
            canEnd: false,
            canDelete: false,
          },
        }),
      );
      const view = await renderView();
      await loaded(view);

      expect(view.getByText("The worker stopped.")).toBeTruthy();
      expect(view.getByText("An execution manager can retry")).toBeTruthy();
      expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    test("ended: read-only, with no End button", async () => {
      serve(chat({ state: "ended" }));
      const view = await renderView();
      await loaded(view);

      expect(view.getByText("This conversation has ended.")).toBeTruthy();
      expect(view.getByText("This conversation has ended")).toBeTruthy();
      expect(view.queryByLabelText("Message Scarn")).toBeNull();
      expect(view.queryByRole("button", { name: "End" })).toBeNull();
      expect(view.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    test("hides the grilling actions", async () => {
      serve(chat({ state: "waiting" }));
      const view = await renderView();
      await loaded(view);

      expect(
        view.queryByRole("button", { name: "Continue without reply" }),
      ).toBeNull();
      expect(view.queryByRole("button", { name: "Done" })).toBeNull();
      expect(
        view.queryByRole("button", { name: "Ask it to finish" }),
      ).toBeNull();
    });
  });

  describe("header", () => {
    test("shows the title, creator and context line, and copies the full commit", async () => {
      const written: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            written.push(text);
            return Promise.resolve();
          },
        },
      });
      serve(chat({ state: "waiting" }));
      const view = await renderView();
      await loaded(view);

      expect(
        view.getByRole("heading", { name: "Where is auth handled?" }),
      ).toBeTruthy();
      expect(view.getByText("Started by alice")).toBeTruthy();
      const context = view.getByTestId("chat-context");
      expect(context.textContent).toContain("acme/demo");
      expect(context.textContent).toContain("main");
      expect(context.textContent).toContain(COMMIT.slice(0, 12));
      expect(context.textContent).not.toContain(COMMIT);

      fireEvent.click(view.getByRole("button", { name: "Copy full commit" }));
      expect(written).toEqual([COMMIT]);
      expect(
        view.getByRole("link", { name: "Runs" }).getAttribute("href"),
      ).toMatch(/\/runs\?whatRan=task$/);
    });

    test("in a run's frame, keeps only the context line and the actions", async () => {
      serve(chat({ state: "waiting" }));
      const view = await renderView(undefined, true);
      await loaded(view);

      expect(
        view.queryByRole("heading", { name: "Where is auth handled?" }),
      ).toBeNull();
      expect(view.queryByText("Started by alice")).toBeNull();
      expect(view.queryByRole("link", { name: "Runs" })).toBeNull();
      expect(view.getByTestId("chat-context-bar").textContent).toContain(
        "acme/demo",
      );
      expect(view.getByRole("button", { name: "End" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    test("before a pin, says the commit resolves when execution starts", async () => {
      serve(
        chat({
          state: "queued",
          latestRun: null,
          context: {
            kind: "project_repo",
            repository: "https://github.com/acme/demo",
            branch: null,
            commit: null,
            pinnedAt: null,
          },
        }),
      );
      const view = await renderView();
      await loaded(view);

      expect(view.getByText(/Resolved when execution starts/)).toBeTruthy();
      expect(
        view.queryByRole("button", { name: "Copy full commit" }),
      ).toBeNull();
    });
  });

  describe("actions", () => {
    test("a reply posts and the chat refreshes from the response", async () => {
      serve(chat({ state: "waiting" }));
      api.reply = () =>
        Promise.resolve({ data: chat({ state: "queued" }), error: null });
      const view = await renderView();
      await loaded(view);

      const input = view.getByLabelText("Message Scarn");
      fireEvent.focusIn(input);
      fireEvent.change(input, { target: { value: "And sessions?" } });
      fireEvent.keyUp(input);
      fireEvent.click(view.getByRole("button", { name: "Send reply" }));

      await waitFor(() => {
        expect(api.replyBodies).toEqual([{ body: "And sessions?" }]);
      });
      await waitFor(() => {
        expect(view.getByTestId("chat-reply-blocked").textContent).toBe(
          "The agent is working…",
        );
      });
    });

    test("Retry posts the latest run id", async () => {
      serve(chat({ state: "failed", error: { code: "X", message: "Boom" } }));
      api.retry = () =>
        Promise.resolve({ data: chat({ state: "retry_queued" }), error: null });
      const view = await renderView();
      await loaded(view);

      fireEvent.click(view.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(api.retryBodies).toEqual([{ expectedLatestRunId: RUN_ID }]);
      });
      await waitFor(() => {
        expect(view.queryByTestId("chat-failure")).toBeNull();
      });
    });

    test("a 409 on Retry reads the chat again", async () => {
      serve(chat({ state: "failed", error: { code: "X", message: "Boom" } }));
      api.retry = () => failWith(409, "CONVERSATION_RETRY_STALE");
      const view = await renderView();
      await loaded(view);
      const reads = api.getCalls;

      serve(chat({ state: "running" }));
      fireEvent.click(view.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(api.getCalls).toBeGreaterThan(reads);
      });
      await waitFor(() => {
        expect(view.getByText("Scarn is working…")).toBeTruthy();
      });
    });

    test("End confirms, posts, and leaves the chat read-only", async () => {
      serve(chat({ state: "waiting" }));
      api.end = () =>
        Promise.resolve({ data: chat({ state: "ended" }), error: null });
      const view = await renderView();
      await loaded(view);

      fireEvent.click(view.getByRole("button", { name: "End" }));
      expect(api.endCalls).toBe(0);
      const dialog = await view.findByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "End conversation" }),
      );

      await waitFor(() => {
        expect(api.endCalls).toBe(1);
      });
      await waitFor(() => {
        expect(view.getByText("This conversation has ended")).toBeTruthy();
      });
      expect(view.queryByLabelText("Message Scarn")).toBeNull();
    });

    test("Delete shows the exact warning, then goes to the list after 204", async () => {
      serve(chat({ state: "waiting" }));
      const view = await renderView();
      await loaded(view);

      fireEvent.click(view.getByRole("button", { name: "Delete" }));
      const dialog = await view.findByRole("dialog");
      expect(DELETE_CONFIRMATION_TEXT).toBe(
        "Deleted conversations can't be recovered.",
      );
      expect(
        within(dialog).getByText("Deleted conversations can't be recovered."),
      ).toBeTruthy();
      expect(api.deleteCalls).toBe(0);
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Delete conversation" }),
      );

      await waitFor(() => {
        expect(api.pushes).toEqual(["/alice/demo/runs"]);
      });
      expect(api.deleteCalls).toBe(1);
    });
  });
});
