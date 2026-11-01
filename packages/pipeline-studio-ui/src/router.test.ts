import { describe, expect, test } from "bun:test";
import {
  createRouter,
  isPlainLeftClick,
  parseRoute,
  pipelinePath,
  templatePath,
  type LinkClickEvent,
  type RouterEnvironment,
} from "./router";

/** An in-memory `window`: a history stack with Back that fires `popstate`. */
function fakeWindow(initialPath: string) {
  const entries = [initialPath];
  let index = 0;
  const listeners = new Set<() => void>();
  const environment: RouterEnvironment = {
    location: {
      get pathname() {
        return entries[index] ?? "/";
      },
    },
    history: {
      pushState(_data, _unused, url) {
        entries.splice(index + 1);
        entries.push(url);
        index = entries.length - 1;
      },
      replaceState(_data, _unused, url) {
        entries[index] = url;
      },
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    environment,
    entries,
    back() {
      index = Math.max(0, index - 1);
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

const plainClick: LinkClickEvent = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

describe("parseRoute", () => {
  test("maps each path to its screen", () => {
    expect(parseRoute("/")).toEqual({ name: "pipelines" });
    expect(parseRoute("/pipelines")).toEqual({ name: "pipelines" });
    expect(parseRoute("/pipelines/triage")).toEqual({
      name: "pipelines",
      pipelineKey: "triage",
    });
    expect(parseRoute("/templates")).toEqual({ name: "templates" });
    expect(parseRoute("/templates/")).toEqual({ name: "templates" });
    expect(parseRoute("/templates/wayfinder")).toEqual({
      name: "template",
      key: "wayfinder",
    });
  });

  test("decodes keys and rejects unknown or malformed paths", () => {
    expect(parseRoute("/pipelines/a%20b")).toEqual({
      name: "pipelines",
      pipelineKey: "a b",
    });
    expect(parseRoute("/templates/%E0%A4%A")).toEqual({ name: "notFound" });
    expect(parseRoute("/templates/wayfinder/extra")).toEqual({
      name: "notFound",
    });
    expect(parseRoute("/nope")).toEqual({ name: "notFound" });
  });

  test("round-trips the path builders", () => {
    expect(pipelinePath(null)).toBe("/");
    expect(parseRoute(pipelinePath("my pipe"))).toEqual({
      name: "pipelines",
      pipelineKey: "my pipe",
    });
    expect(parseRoute(templatePath("web-repro-playwright"))).toEqual({
      name: "template",
      key: "web-repro-playwright",
    });
  });
});

describe("isPlainLeftClick", () => {
  test("handles only an unmodified primary click", () => {
    expect(isPlainLeftClick(plainClick)).toBe(true);
    expect(isPlainLeftClick({ ...plainClick, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plainClick, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plainClick, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plainClick, altKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plainClick, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...plainClick, defaultPrevented: true })).toBe(
      false,
    );
  });
});

describe("createRouter", () => {
  test("a direct load reads the route from the current path", () => {
    const win = fakeWindow("/templates/wayfinder");
    const router = createRouter(win.environment);
    expect(router.getRoute()).toEqual({ name: "template", key: "wayfinder" });
  });

  test("navigate pushes, notifies, and returns a stable route object", () => {
    const win = fakeWindow("/");
    const router = createRouter(win.environment);
    let notified = 0;
    router.subscribe(() => {
      notified += 1;
    });

    router.navigate("/templates");
    expect(win.entries).toEqual(["/", "/templates"]);
    expect(notified).toBe(1);
    expect(router.getRoute()).toBe(router.getRoute());

    router.navigate("/templates");
    expect(win.entries).toEqual(["/", "/templates"]);
    expect(notified).toBe(1);
  });

  test("Back after a replacing Use skips the template page", () => {
    const win = fakeWindow("/");
    const router = createRouter(win.environment);
    const seen: string[] = [];
    router.subscribe(() => {
      seen.push(router.getRoute().name);
    });

    router.navigate("/templates");
    router.navigate(templatePath("wayfinder"));
    router.navigate(pipelinePath("wayfinder"), { replace: true });
    expect(win.entries).toEqual(["/", "/templates", "/pipelines/wayfinder"]);
    expect(router.getRoute()).toEqual({
      name: "pipelines",
      pipelineKey: "wayfinder",
    });

    win.back();
    expect(router.getRoute()).toEqual({ name: "templates" });
    expect(seen).toEqual(["templates", "template", "pipelines", "templates"]);
  });

  test("listens for popstate only while subscribed", () => {
    const win = fakeWindow("/");
    const router = createRouter(win.environment);
    const unsubscribeA = router.subscribe(() => {});
    const unsubscribeB = router.subscribe(() => {});
    expect(win.listenerCount()).toBe(1);
    unsubscribeA();
    expect(win.listenerCount()).toBe(1);
    unsubscribeB();
    expect(win.listenerCount()).toBe(0);
  });
});
