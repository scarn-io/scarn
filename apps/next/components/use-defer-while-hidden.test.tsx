import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { installDom as installTestDom } from "@/tests/support/install-dom";

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { isPageHidden, useDeferWhileHidden, waitUntilVisible } =
  await import("./use-defer-while-hidden");

const originalEvent = globalThis.Event;
let hidden = false;

function installDom() {
  const dom = installTestDom();
  Object.defineProperty(dom.window.document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.assign(globalThis, {
    Event: dom.window.Event,
  });
}

function setHidden(value: boolean) {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function renderDefer(enabled = true) {
  let visibleCalls = 0;
  const onVisible = () => {
    visibleCalls += 1;
  };
  const { result, unmount } = renderHook(() =>
    useDeferWhileHidden(onVisible, enabled),
  );
  return { deferIfHidden: result.current, unmount, calls: () => visibleCalls };
}

describe("useDeferWhileHidden", () => {
  beforeEach(() => {
    cleanup();
    hidden = false;
    installDom();
  });

  afterAll(() => {
    cleanup();
    globalThis.Event = originalEvent;
  });

  test("isPageHidden follows document.hidden", () => {
    expect(isPageHidden()).toBe(false);
    hidden = true;
    expect(isPageHidden()).toBe(true);
  });

  test("a visible page is not deferred and owes nothing", () => {
    const hook = renderDefer();

    expect(hook.deferIfHidden()).toBe(false);
    setHidden(true);
    setHidden(false);
    expect(hook.calls()).toBe(0);
  });

  test("deferring while hidden runs onVisible once when the tab is visible again", () => {
    const hook = renderDefer();
    hidden = true;

    expect(hook.deferIfHidden()).toBe(true);
    setHidden(false);
    setHidden(true);
    setHidden(false);
    expect(hook.calls()).toBe(1);
  });

  test("a visible check clears an owed refresh", () => {
    const hook = renderDefer();
    hidden = true;
    hook.deferIfHidden();
    hidden = false;
    expect(hook.deferIfHidden()).toBe(false);

    setHidden(false);
    expect(hook.calls()).toBe(0);
  });

  test("does nothing when disabled or unmounted", () => {
    const disabled = renderDefer(false);
    const unmounted = renderDefer();
    hidden = true;
    disabled.deferIfHidden();
    unmounted.deferIfHidden();
    unmounted.unmount();

    setHidden(false);
    expect(disabled.calls()).toBe(0);
    expect(unmounted.calls()).toBe(0);
  });
});

function trackVisibilityListeners() {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  document.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => {
    if (type === "visibilitychange") listeners.add(listener);
    add(type, listener);
  };
  document.removeEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => {
    if (type === "visibilitychange") listeners.delete(listener);
    remove(type, listener);
  };
  return () => listeners.size;
}

function track(promise: Promise<void>) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  return async () => {
    await Promise.resolve();
    await Promise.resolve();
    return settled;
  };
}

describe("waitUntilVisible", () => {
  beforeEach(() => {
    hidden = false;
    installDom();
  });

  afterAll(() => {
    globalThis.Event = originalEvent;
  });

  test("resolves immediately when the tab is visible", async () => {
    const listenerCount = trackVisibilityListeners();
    const isSettled = track(waitUntilVisible(new AbortController().signal));

    expect(await isSettled()).toBe(true);
    expect(listenerCount()).toBe(0);
  });

  test("resolves immediately when the signal is already aborted", async () => {
    hidden = true;
    const listenerCount = trackVisibilityListeners();
    const controller = new AbortController();
    controller.abort();
    const isSettled = track(waitUntilVisible(controller.signal));

    expect(await isSettled()).toBe(true);
    expect(listenerCount()).toBe(0);
  });

  test("resolves on visibilitychange to visible and removes its listener", async () => {
    hidden = true;
    const listenerCount = trackVisibilityListeners();
    const isSettled = track(waitUntilVisible(new AbortController().signal));

    expect(await isSettled()).toBe(false);
    expect(listenerCount()).toBe(1);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(await isSettled()).toBe(false);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await isSettled()).toBe(true);
    expect(listenerCount()).toBe(0);
  });

  test("resolves and removes its listener on abort", async () => {
    hidden = true;
    const listenerCount = trackVisibilityListeners();
    const controller = new AbortController();
    const isSettled = track(waitUntilVisible(controller.signal));

    expect(await isSettled()).toBe(false);
    controller.abort();

    expect(await isSettled()).toBe(true);
    expect(listenerCount()).toBe(0);
  });
});
