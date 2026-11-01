import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";
import {
  createRouter,
  isPlainLeftClick,
  type NavigateOptions,
  type Route,
  type Router,
} from "./router";

/** Binds `router.ts` to the browser's `window` and to React. */
let browserRouter: Router | null = null;

function getBrowserRouter(): Router {
  browserRouter ??= createRouter(window);
  return browserRouter;
}

export function navigate(path: string, options?: NavigateOptions): void {
  getBrowserRouter().navigate(path, options);
}

function subscribeToRoute(listener: () => void): () => void {
  return getBrowserRouter().subscribe(listener);
}

function getCurrentRoute(): Route {
  return getBrowserRouter().getRoute();
}

/** The current route; re-renders on `navigate` and on Back/Forward. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribeToRoute, getCurrentRoute);
}

export type LinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> & {
  href: string;
};

/**
 * A real `<a href>` that navigates in-page on a plain left click and leaves
 * every other click (Cmd/Ctrl/Shift/middle) to the browser.
 */
export function Link({ href, onClick, children, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (rest.target !== undefined && rest.target !== "_self") return;
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
