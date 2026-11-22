import { JSDOM } from "jsdom";

export type InstallDomOptions = {
  url?: string;
  pretendToBeVisual?: boolean;
};

/**
 * Bun's default inspection of a JSDOM node walks its whole window: a single
 * failed `expect(node).toBeNull()` builds a ~20 MB message. `waitFor` retries
 * such assertions every 50 ms, which on a loaded CI runner turned sub-second
 * tests into multi-minute timeouts. Nodes print as truncated HTML instead.
 */
const MAX_INSPECTED_CHARS = 2_000;

/**
 * Installs a fresh JSDOM as the global browser environment for component and
 * hook tests, and returns it so a test can stub extra globals or close it.
 *
 * Call it before React DOM is first imported when a file types into
 * controlled fields: React DOM decides at import time whether the DOM can emit
 * `input` events, and without them `fireEvent.change` never reaches a
 * controlled field's `onChange`.
 */
export function installDom({
  url = "http://localhost",
  pretendToBeVisual = false,
}: InstallDomOptions = {}): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url,
    pretendToBeVisual,
  });

  Object.assign(globalThis, {
    document: dom.window.document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
    navigator: dom.window.navigator,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  (dom.window.Node.prototype as unknown as Record<symbol, unknown>)[
    Bun.inspect.custom
  ] = function inspectNode(this: Node) {
    const html =
      this instanceof dom.window.Element
        ? this.outerHTML
        : `#${this.nodeName} ${this.textContent ?? ""}`;
    return html.length > MAX_INSPECTED_CHARS
      ? `${html.slice(0, MAX_INSPECTED_CHARS)}…`
      : html;
  };

  return dom;
}
