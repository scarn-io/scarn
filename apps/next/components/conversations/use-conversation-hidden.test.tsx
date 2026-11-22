import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  api,
  conversationId,
  getMock,
  resetApi,
} from "./conversation-panel-test-support";

const { act, cleanup, render } = await import("@testing-library/react");
const { useConversation } = await import("./use-conversation");

function Probe() {
  const { conversation } = useConversation(conversationId, {
    pollIntervalMs: 5_000,
  });
  return <span>{conversation?.status ?? "loading"}</span>;
}

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

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
};

const dispatch = (target: EventTarget, type: string) => {
  act(() => {
    target.dispatchEvent(new window.Event(type));
  });
};

describe("useConversation while the tab is hidden", () => {
  beforeEach(() => {
    resetApi();
    setHidden(false);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    cleanup();
    setHidden(false);
  });

  test("an agent_turn conversation skips polls while hidden and catches up once when visible", async () => {
    api.status = "agent_turn";
    render(<Probe />);
    await flush();
    expect(getMock).toHaveBeenCalledTimes(1);

    setHidden(true);
    await advance(20_000);
    expect(getMock).toHaveBeenCalledTimes(1);

    setHidden(false);
    dispatch(document, "visibilitychange");
    await flush();
    expect(getMock).toHaveBeenCalledTimes(2);

    dispatch(window, "focus");
    await flush();
    expect(getMock).toHaveBeenCalledTimes(2);

    await advance(5_000);
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  test("a visible agent_turn conversation does not re-read on focus", async () => {
    api.status = "agent_turn";
    render(<Probe />);
    await flush();

    dispatch(window, "focus");
    dispatch(document, "visibilitychange");
    await flush();
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
