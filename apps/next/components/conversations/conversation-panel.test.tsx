import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  agentTaskId,
  api,
  buildConversation,
  continueMock,
  conversationId,
  doneMock,
  getMock,
  postMessageMock,
  resetApi,
} from "./conversation-panel-test-support";

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ASK_TO_FINISH_MESSAGE, ConversationMessageBox, ConversationPanel } =
  await import("./conversation-panel");
const { useConversation } = await import("./use-conversation");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const ALL = ["comments:create", "executions:write"];

function Harness({
  onShowWork,
  onChanged,
  pollIntervalMs,
}: {
  onShowWork: (taskRunId: string) => void;
  onChanged: () => void;
  pollIntervalMs?: number;
}) {
  const data = useConversation(conversationId, { onChanged, pollIntervalMs });
  return (
    <>
      <ConversationPanel
        data={data}
        onShowWork={onShowWork}
        agentName="Grill"
      />
      <ConversationMessageBox data={data} agentName="Grill" />
    </>
  );
}

const renderPanel = ({
  permissions = ALL,
  pollIntervalMs,
}: { permissions?: string[]; pollIntervalMs?: number } = {}) => {
  const onShowWork = mock((taskRunId: string) => {
    void taskRunId;
  });
  const onChanged = mock(() => {});
  const view = render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId="019e709b-574f-742c-8fda-00a1bcc71b9d"
      isMember
      permissions={permissions}
    >
      <Harness
        onShowWork={onShowWork}
        onChanged={onChanged}
        pollIntervalMs={pollIntervalMs}
      />
    </ProjectRouteProvider>,
  );
  return { view, onShowWork, onChanged };
};

const loaded = async (view: ReturnType<typeof render>) => {
  await waitFor(() => {
    expect(view.getByText("SAML only, or SAML and OIDC?")).toBeTruthy();
  });
};

const replyInput = (view: ReturnType<typeof render>) =>
  view.getByLabelText("Message Grill") as HTMLTextAreaElement;

describe("ConversationPanel", () => {
  beforeEach(() => {
    resetApi();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows agent, person and system messages as a chat", async () => {
    const { view } = renderPanel();
    await loaded(view);

    expect(api.requestedIds[0]).toBe(conversationId);
    expect(view.getByTestId("conversation-agent-message").textContent).toMatch(
      /^GGrill/,
    );
    expect(view.getByTestId("user-bubble").textContent).toBe(
      "What's the cost of OIDC later?",
    );
    expect(
      view.getByText(/alex chose to continue without a reply/),
    ).toBeTruthy();
  });

  test("Show work opens the transcript of the attempt that wrote the message", async () => {
    const { view, onShowWork } = renderPanel();
    await loaded(view);

    fireEvent.click(view.getByRole("button", { name: "Show work" }));
    expect(onShowWork).toHaveBeenCalledWith(agentTaskId);
  });

  test("says the agent is thinking in agent_turn, with no message box or actions", async () => {
    api.status = "agent_turn";
    const { view } = renderPanel();
    await loaded(view);

    expect(view.getByText("Grill is thinking…")).toBeTruthy();
    expect(view.queryByLabelText("Message Grill")).toBeNull();
    expect(
      view.queryByRole("button", { name: "Continue without reply" }),
    ).toBeNull();
  });

  test("polls while the agent has the floor", async () => {
    api.status = "agent_turn";
    const { view } = renderPanel({ pollIntervalMs: 10 });
    await loaded(view);

    api.status = "waiting_for_person";
    await waitFor(() => {
      expect(view.getByText("Waiting for a reply")).toBeTruthy();
    });
    const calls = getMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getMock.mock.calls.length).toBe(calls);
  });

  test("the message box sends a reply in waiting_for_person", async () => {
    const { view, onChanged } = renderPanel();
    await loaded(view);

    fireEvent.change(replyInput(view), { target: { value: "Both, please" } });
    fireEvent.click(view.getByRole("button", { name: "Send reply" }));

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith({ body: "Both, please" });
    });
    await waitFor(() => {
      expect(replyInput(view).value).toBe("");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("the message box stays in reply_pending, without the waiting actions", async () => {
    api.status = "reply_pending";
    const { view } = renderPanel();
    await loaded(view);

    expect(replyInput(view)).toBeTruthy();
    expect(
      view.getByText(
        "Grill is thinking — anything you send joins its next turn",
      ),
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Continue without reply" }),
    ).toBeNull();
    expect(view.queryByRole("button", { name: "Ask it to finish" })).toBeNull();
  });

  test("Enter sends on a keyboard-and-mouse device", async () => {
    const { view } = renderPanel();
    await loaded(view);

    expect(
      view.getByText("Enter to send · Shift+Enter for a new line"),
    ).toBeTruthy();
    fireEvent.change(replyInput(view), { target: { value: "Both" } });
    fireEvent.keyDown(replyInput(view), { key: "Enter" });

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith({ body: "Both" });
    });
  });

  test("Shift+Enter doesn't send", async () => {
    const { view } = renderPanel();
    await loaded(view);

    fireEvent.change(replyInput(view), { target: { value: "Both" } });
    fireEvent.keyDown(replyInput(view), { key: "Enter", shiftKey: true });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(replyInput(view).value).toBe("Both");
  });

  test("Cmd+Enter sends", async () => {
    const { view } = renderPanel();
    await loaded(view);

    fireEvent.change(replyInput(view), { target: { value: "Both" } });
    fireEvent.keyDown(replyInput(view), { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith({ body: "Both" });
    });
  });

  test("your message shows straight away while it sends", async () => {
    let resolvePost: (value: {
      data: unknown;
      error: unknown;
    }) => void = () => {};
    postMessageMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        }),
    );
    const { view } = renderPanel();
    await loaded(view);

    fireEvent.change(replyInput(view), { target: { value: "Both, please" } });
    fireEvent.click(view.getByRole("button", { name: "Send reply" }));

    await waitFor(() => {
      expect(
        view.getByTestId("conversation-local-message").textContent,
      ).toContain("Both, please");
    });
    expect(replyInput(view).value).toBe("");
    expect(view.getByText("Sending…")).toBeTruthy();

    resolvePost({
      data: buildConversation("reply_pending", api.endsWith),
      error: null,
    });
    await waitFor(() => {
      expect(view.queryByTestId("conversation-local-message")).toBeNull();
    });
  });

  test("a refused reply stays in the chat with a retry, and shows why", async () => {
    api.messageResponse = () => ({
      data: null,
      error: {
        value: {
          status: 409,
          code: "CONVERSATION_NOT_WAITING",
          detail: "Scarn is working; wait for its reply",
        },
      },
    });
    const { view, onChanged } = renderPanel();
    await loaded(view);

    fireEvent.change(replyInput(view), { target: { value: "Both" } });
    fireEvent.click(view.getByRole("button", { name: "Send reply" }));

    await waitFor(() => {
      expect(
        view.getByText("Scarn is working; wait for its reply"),
      ).toBeTruthy();
    });
    expect(
      view.getByTestId("conversation-local-message").textContent,
    ).toContain("Both");
    expect(
      view.getByRole("button", { name: "Not sent · Tap to retry" }),
    ).toBeTruthy();
    expect(replyInput(view).value).toBe("");
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("retrying a failed message sends it again", async () => {
    api.messageResponse = () => ({
      data: null,
      error: { value: { status: 500, detail: "Server hiccup" } },
    });
    const { view, onChanged } = renderPanel();
    await loaded(view);

    fireEvent.change(replyInput(view), { target: { value: "Both" } });
    fireEvent.click(view.getByRole("button", { name: "Send reply" }));
    await waitFor(() => {
      expect(
        view.getByRole("button", { name: "Not sent · Tap to retry" }),
      ).toBeTruthy();
    });

    api.messageResponse = () => ({
      data: buildConversation("reply_pending", api.endsWith),
      error: null,
    });
    fireEvent.click(
      view.getByRole("button", { name: "Not sent · Tap to retry" }),
    );

    await waitFor(() => {
      expect(view.queryByTestId("conversation-local-message")).toBeNull();
    });
    expect(postMessageMock).toHaveBeenCalledTimes(2);
    expect(postMessageMock.mock.calls[1]?.[0]).toEqual({ body: "Both" });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("no message box or Ask it to finish without comments:create", async () => {
    const { view } = renderPanel({ permissions: ["executions:write"] });
    await loaded(view);

    expect(view.queryByLabelText("Message Grill")).toBeNull();
    expect(view.queryByRole("button", { name: "Ask it to finish" })).toBeNull();
    expect(
      view.getByRole("button", { name: "Continue without reply" }),
    ).toBeTruthy();
  });

  test("Ask it to finish sends the fixed message on a step with findings", async () => {
    const { view } = renderPanel();
    await loaded(view);

    expect(view.queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Ask it to finish" }));

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith({
        body: ASK_TO_FINISH_MESSAGE,
      });
    });
    expect(ASK_TO_FINISH_MESSAGE).toBe(
      "If you're done, submit your findings now.",
    );
    expect(doneMock).not.toHaveBeenCalled();
  });

  test("Done ends a conversation step through the done route", async () => {
    api.endsWith = "conversation";
    const { view, onChanged } = renderPanel();
    await loaded(view);

    expect(view.queryByRole("button", { name: "Ask it to finish" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(doneMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.getByText("This conversation has ended.")).toBeTruthy();
    });
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(view.queryByLabelText("Message Grill")).toBeNull();
  });

  test("Done needs executions:write", async () => {
    api.endsWith = "conversation";
    const { view } = renderPanel({ permissions: ["comments:create"] });
    await loaded(view);

    expect(view.queryByRole("button", { name: "Done" })).toBeNull();
    expect(
      view.queryByRole("button", { name: "Continue without reply" }),
    ).toBeNull();
  });

  test("Continue without reply posts to the continue route", async () => {
    const { view, onChanged } = renderPanel();
    await loaded(view);

    fireEvent.click(
      view.getByRole("button", { name: "Continue without reply" }),
    );

    await waitFor(() => {
      expect(continueMock).toHaveBeenCalledTimes(1);
    });
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("a closed conversation takes no replies", async () => {
    api.status = "closed";
    const { view } = renderPanel();
    await loaded(view);

    expect(view.getByText("This conversation has ended.")).toBeTruthy();
    expect(view.queryByLabelText("Message Grill")).toBeNull();
    expect(
      view.queryByRole("button", { name: /Continue|Done|Ask/ }),
    ).toBeNull();
  });
});
