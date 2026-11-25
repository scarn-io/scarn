import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  api,
  buildChat,
  conversationId,
  failWith,
  projectId,
  resetApi,
  serveConversation,
  setDocumentHidden,
  withProjectRoute,
} from "./repo-conversations-test-support";

const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { RepoConversationView } = await import("./repo-conversation-view");

const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

const advance = async (ms: number) => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
};

const renderView = async (pollIntervalsMs?: { active: number; idle: number }) =>
  render(
    await withProjectRoute(
      <RepoConversationView
        conversationId={conversationId}
        projectId={projectId}
        {...(pollIntervalsMs ? { pollIntervalsMs } : {})}
      />,
      ["comments:write"],
    ),
  );

describe("RepoConversationView polling", () => {
  beforeEach(() => {
    resetApi();
    setDocumentHidden(false);
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
  });

  test("every 5s while queued or running", async () => {
    jest.useFakeTimers();
    serveConversation(buildChat({ state: "running" }));
    await renderView();
    await flush();
    expect(api.getCalls).toBe(1);

    await advance(4_999);
    expect(api.getCalls).toBe(1);
    await advance(1);
    expect(api.getCalls).toBe(2);

    serveConversation(buildChat({ state: "queued" }));
    await advance(5_000);
    expect(api.getCalls).toBe(3);
    await advance(5_000);
    expect(api.getCalls).toBe(4);
  });

  for (const state of ["waiting", "failed", "ended"] as const) {
    test(`every 30s while ${state}`, async () => {
      jest.useFakeTimers();
      serveConversation(buildChat({ state }));
      await renderView();
      await flush();
      expect(api.getCalls).toBe(1);

      await advance(29_999);
      expect(api.getCalls).toBe(1);
      await advance(1);
      expect(api.getCalls).toBe(2);
    });
  }

  test("pauses while hidden and re-reads when visible again or on focus", async () => {
    jest.useFakeTimers();
    serveConversation(buildChat({ state: "running" }));
    await renderView();
    await flush();
    expect(api.getCalls).toBe(1);

    setDocumentHidden(true);
    await advance(20_000);
    expect(api.getCalls).toBe(1);

    setDocumentHidden(false);
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await flush();
    expect(api.getCalls).toBe(2);

    act(() => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await flush();
    expect(api.getCalls).toBe(3);
  });

  for (const status of [403, 404]) {
    test(`a ${String(status)} clears the transcript`, async () => {
      serveConversation(buildChat({ state: "waiting" }));
      const view = await renderView({ active: 20, idle: 20 });
      await waitFor(() => {
        expect(view.getByText("In the auth middleware.")).toBeTruthy();
      });

      api.get = () => failWith(status, "NOPE");
      await waitFor(() => {
        expect(view.getByTestId("chat-unavailable")).toBeTruthy();
      });
      expect(view.queryByText("In the auth middleware.")).toBeNull();
      expect(view.queryByText("Where is auth handled?")).toBeNull();
      expect(view.queryByLabelText("Message Scarn")).toBeNull();
    });
  }
});
