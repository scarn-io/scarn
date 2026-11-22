/**
 * `useFollowScroll` over a stubbed scroll container: jsdom does no layout, so
 * the container's `scrollHeight`/`clientHeight` are set by hand and
 * `scrollTop` is a plain writable number.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFollowScroll } from "./use-follow-scroll";
import { installDom } from "@/tests/support/install-dom";

const CLIENT_HEIGHT = 400;
const LINE_HEIGHT = 20;

type Container = HTMLDivElement & { setLines: (count: number) => void };

function stubContainer(lines: number): Container {
  const el = document.createElement("div") as Container;
  let scrollHeight = 0;
  let scrollTop = 0;
  Object.defineProperty(el, "clientHeight", { value: CLIENT_HEIGHT });
  Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(el, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, scrollHeight - CLIENT_HEIGHT));
    },
  });
  el.setLines = (count) => {
    scrollHeight = Math.max(CLIENT_HEIGHT, count * LINE_HEIGHT);
  };
  el.setLines(lines);
  return el;
}

function scrollTo(el: Container, top: number) {
  act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new window.Event("scroll"));
  });
}

function renderFollow(el: Container, lines: number, initiallyPinned = true) {
  const ref = { current: el };
  return renderHook(
    ({ count }: { count: number }) =>
      useFollowScroll(ref, count, { initiallyPinned }),
    { initialProps: { count: lines } },
  );
}

function addLines(
  el: Container,
  hook: ReturnType<typeof renderFollow>,
  lines: number,
) {
  el.setLines(lines);
  hook.rerender({ count: lines });
}

describe("useFollowScroll", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("starts at the bottom and follows new content while pinned", () => {
    const el = stubContainer(100);
    const hook = renderFollow(el, 100);
    expect(el.scrollTop).toBe(100 * LINE_HEIGHT - CLIENT_HEIGHT);

    addLines(el, hook, 150);

    expect(el.scrollTop).toBe(150 * LINE_HEIGHT - CLIENT_HEIGHT);
    expect(hook.result.current.unseen).toBe(0);
  });

  test("stays pinned when scrolled to within 80px of the bottom", () => {
    const el = stubContainer(100);
    const hook = renderFollow(el, 100);
    scrollTo(el, 100 * LINE_HEIGHT - CLIENT_HEIGHT - 70);

    addLines(el, hook, 110);

    expect(el.scrollTop).toBe(110 * LINE_HEIGHT - CLIENT_HEIGHT);
    expect(hook.result.current.unseen).toBe(0);
  });

  test("stops following and counts unseen lines after scrolling up", () => {
    const el = stubContainer(100);
    const hook = renderFollow(el, 100);
    scrollTo(el, 0);

    addLines(el, hook, 105);
    addLines(el, hook, 112);

    expect(el.scrollTop).toBe(0);
    expect(hook.result.current.unseen).toBe(12);
  });

  test("jumpToLatest scrolls to the bottom, resets the count and resumes following", () => {
    const el = stubContainer(100);
    const hook = renderFollow(el, 100);
    scrollTo(el, 0);
    addLines(el, hook, 120);
    expect(hook.result.current.unseen).toBe(20);

    act(() => {
      hook.result.current.jumpToLatest();
    });

    expect(el.scrollTop).toBe(120 * LINE_HEIGHT - CLIENT_HEIGHT);
    expect(hook.result.current.unseen).toBe(0);

    addLines(el, hook, 130);
    expect(el.scrollTop).toBe(130 * LINE_HEIGHT - CLIENT_HEIGHT);
  });

  test("scrolling back to the bottom resets the count", () => {
    const el = stubContainer(100);
    const hook = renderFollow(el, 100);
    scrollTo(el, 0);
    addLines(el, hook, 120);

    scrollTo(el, 120 * LINE_HEIGHT);

    expect(hook.result.current.unseen).toBe(0);
  });

  test("does not scroll on mount when it starts unpinned", () => {
    const el = stubContainer(100);
    const hook = renderFollow(el, 100, false);

    addLines(el, hook, 110);

    expect(el.scrollTop).toBe(0);
    expect(hook.result.current.unseen).toBe(10);
  });
});
