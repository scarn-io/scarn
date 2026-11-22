import { afterEach, describe, expect, mock, test } from "bun:test";
import type { StepMessageGate } from "./execution-step-action-guards";
import { installDom } from "@/tests/support/install-dom";

/**
 * The DOM globals are installed before React DOM and Testing Library load
 * (hence the dynamic imports below): React DOM decides at import time whether
 * the DOM can emit `input` events, and without that `fireEvent.change` never
 * reaches the textarea's `onChange`.
 */
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
const { StepMessageComposer } = await import("./step-message-composer");

const renderComposer = ({
  gate = { kind: "ready" },
  error = "",
  quote = null,
  rerunSteps = ["Fix", "Review", "Ship"],
  onClearQuote = mock(() => {}),
  onSend = mock(() => Promise.resolve(true)),
}: {
  gate?: StepMessageGate;
  error?: string;
  quote?: string | null;
  rerunSteps?: string[];
  onClearQuote?: () => void;
  onSend?: (body: string, quoteText: string | null) => Promise<boolean>;
} = {}) => {
  const view = render(
    <StepMessageComposer
      gate={gate}
      rerunSteps={rerunSteps}
      quote={quote}
      onClearQuote={onClearQuote}
      pending={false}
      error={error}
      onSend={onSend}
    />,
  );
  return { view, onSend, onClearQuote };
};

const getInput = (view: ReturnType<typeof render>) =>
  view.getByLabelText("Message to this step") as HTMLTextAreaElement;

describe("StepMessageComposer", () => {
  afterEach(() => {
    cleanup();
  });

  test("Cmd+Enter sends the message; plain Enter doesn't", async () => {
    const onSend = mock(() => Promise.resolve(true));
    const { view } = renderComposer({ onSend });
    const input = getInput(view);
    fireEvent.change(input, { target: { value: "Use the v2 API" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Use the v2 API", null);
    });
  });

  test("Ctrl+Enter sends the message", async () => {
    const onSend = mock(() => Promise.resolve(true));
    const { view } = renderComposer({ onSend });
    const input = getInput(view);
    fireEvent.change(input, { target: { value: "Retry" } });

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("Retry", null);
    });
  });

  test("the send button is disabled while the text is blank", () => {
    const { view } = renderComposer();
    const button = view.getByRole("button", { name: /Send & re-run/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(getInput(view), { target: { value: "   " } });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(getInput(view), { target: { value: "Go" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  test("the consequence line appears once there's text and names the steps it re-runs", () => {
    const { view } = renderComposer();
    expect(view.queryByText(/^Re-runs/)).toBeNull();

    fireEvent.change(getInput(view), { target: { value: "Go" } });
    expect(view.getByText("Re-runs Fix, then Review and Ship")).toBeTruthy();
  });

  test("the consequence line names only the step when it's the last one", () => {
    const { view } = renderComposer({ rerunSteps: ["Ship"] });
    fireEvent.change(getInput(view), { target: { value: "Go" } });
    expect(view.getByText("Re-runs Ship")).toBeTruthy();
  });

  test("renders the quote, and its remove button clears it", () => {
    const onClearQuote = mock(() => {});
    const { view } = renderComposer({
      quote: "the v1 client is deprecated",
      onClearQuote,
    });
    expect(view.getByText("the v1 client is deprecated")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Remove quote" }));
    expect(onClearQuote).toHaveBeenCalledTimes(1);
  });

  test("sends the quote with the message", async () => {
    const onSend = mock(() => Promise.resolve(true));
    const { view } = renderComposer({
      quote: "the v1 client is deprecated",
      onSend,
    });
    fireEvent.change(getInput(view), { target: { value: "Use the v2 API" } });
    fireEvent.keyDown(getInput(view), { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        "Use the v2 API",
        "the v1 client is deprecated",
      );
    });
  });

  test("renders no quote without one", () => {
    const { view } = renderComposer();
    expect(view.queryByRole("button", { name: "Remove quote" })).toBeNull();
  });

  test("clears the text when the send succeeds", async () => {
    const { view } = renderComposer({
      onSend: () => Promise.resolve(true),
    });
    const input = getInput(view);
    fireEvent.change(input, { target: { value: "Use the v2 API" } });
    fireEvent.click(view.getByRole("button", { name: /Send & re-run/ }));

    await waitFor(() => {
      expect(input.value).toBe("");
    });
  });

  test("keeps the text when the send fails, and shows the error", async () => {
    const onSend = mock(() => Promise.resolve(false));
    const { view } = renderComposer({
      onSend,
      error: "the pipeline run still has live work",
    });
    const input = getInput(view);
    fireEvent.change(input, { target: { value: "Use the v2 API" } });
    fireEvent.click(view.getByRole("button", { name: /Send & re-run/ }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(input.value).toBe("Use the v2 API");
    expect(view.getByText("the pipeline run still has live work")).toBeTruthy();
  });

  test("a disabled gate shows its reason and a link to the current visit", () => {
    const { view } = renderComposer({
      gate: {
        kind: "disabled",
        reason: "Switch to the current visit to message this step",
        latestHref: "/tester/demo/runs/run-1?step=fix",
      },
    });

    expect(
      view.getByText(/Switch to the current visit to message this step/),
    ).toBeTruthy();
    expect(
      view
        .getByRole("link", { name: "Go to the current visit" })
        .getAttribute("href"),
    ).toBe("/tester/demo/runs/run-1?step=fix");
    expect(getInput(view).disabled).toBe(true);
  });

  test("a hidden gate renders nothing", () => {
    const { view } = renderComposer({ gate: { kind: "hidden" } });
    expect(view.container.innerHTML).toBe("");
  });
});
