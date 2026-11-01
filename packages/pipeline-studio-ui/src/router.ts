/**
 * The studio's history-API router: three screens don't need a routing
 * library. Everything here is free of `window` so it can be unit tested with a
 * fake history; `router-react.tsx` binds it to the browser and to React.
 *
 * | Path                         | Route                                   |
 * | ---------------------------- | --------------------------------------- |
 * | `/`                          | `pipelines` with no key (default pick)  |
 * | `/pipelines/:key`            | `pipelines` showing `key`               |
 * | `/templates`                 | `templates` (the gallery)               |
 * | `/templates/:key`            | `template` (one template's detail page) |
 */
export type Route =
  | { name: "pipelines"; pipelineKey?: string }
  | { name: "templates" }
  | { name: "template"; key: string }
  | { name: "notFound" };

export const TEMPLATES_PATH = "/templates";

export function pipelinePath(key?: string | null): string {
  return key ? `/pipelines/${encodeURIComponent(key)}` : "/";
}

export function templatePath(key: string): string {
  return `${TEMPLATES_PATH}/${encodeURIComponent(key)}`;
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const [first, second, ...rest] = segments;
  if (rest.length > 0) return { name: "notFound" };

  if (first === undefined) return { name: "pipelines" };

  if (first === "pipelines") {
    if (second === undefined) return { name: "pipelines" };
    const pipelineKey = decodeSegment(second);
    return pipelineKey === null
      ? { name: "notFound" }
      : { name: "pipelines", pipelineKey };
  }

  if (first === "templates") {
    if (second === undefined) return { name: "templates" };
    const key = decodeSegment(second);
    return key === null ? { name: "notFound" } : { name: "template", key };
  }

  return { name: "notFound" };
}

/** The parts of a click event that decide whether a `<Link>` handles it. */
export type LinkClickEvent = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
};

/**
 * True for a plain left click, which the router turns into a `pushState`.
 * Modified or non-primary clicks fall through to the browser so
 * Cmd/Ctrl-click opens a new tab and Shift-click a new window.
 */
export function isPlainLeftClick(event: LinkClickEvent): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** The slice of `window` the router uses. */
export type RouterEnvironment = {
  location: { pathname: string };
  history: {
    pushState(data: null, unused: string, url: string): void;
    replaceState(data: null, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

export type NavigateOptions = {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
};

export type Router = {
  getPathname: () => string;
  getRoute: () => Route;
  navigate: (path: string, options?: NavigateOptions) => void;
  /** Called after every `navigate` and every Back/Forward (`popstate`). */
  subscribe: (listener: () => void) => () => void;
};

export function createRouter(environment: RouterEnvironment): Router {
  const listeners = new Set<() => void>();
  let cachedPathname: string | null = null;
  let cachedRoute: Route = { name: "notFound" };

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function onPopState(): void {
    notify();
  }

  return {
    getPathname: () => environment.location.pathname,
    getRoute() {
      const pathname = environment.location.pathname;
      if (pathname !== cachedPathname) {
        cachedPathname = pathname;
        cachedRoute = parseRoute(pathname);
      }
      return cachedRoute;
    },
    navigate(path, options = {}) {
      if (options.replace) {
        environment.history.replaceState(null, "", path);
      } else if (path !== environment.location.pathname) {
        environment.history.pushState(null, "", path);
      } else {
        return;
      }
      notify();
    },
    subscribe(listener) {
      if (listeners.size === 0) {
        environment.addEventListener("popstate", onPopState);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          environment.removeEventListener("popstate", onPopState);
        }
      };
    },
  };
}
