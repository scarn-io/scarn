import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import { installDom } from "@/tests/support/install-dom";

let mockPathname = "/alice/project-1/work-items";
let mockSearchParams = new URLSearchParams();

void mock.module("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

const { ProjectConversionBanner } = await import("./project-conversion-banner");
const { ProjectRouteProvider } = await import("./project-route-context");

const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
const OTHER_PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe999";

const GUEST_COPY = /you.?re viewing this project as a guest/i;
const DEMO_COPY = /this is the live scarn demo/i;

const renderBanner = (
  isMember: boolean,
  projectId = PROJECT_ID,
  route: { username: string; projectSlug: string } = {
    username: "alice",
    projectSlug: "project-1",
  },
) =>
  render(
    <ProjectRouteProvider
      username={route.username}
      projectSlug={route.projectSlug}
      projectId={projectId}
      isMember={isMember}
    >
      <ProjectConversionBanner />
    </ProjectRouteProvider>,
  );

/** The seeded demo project's route: `DEMO_ACCOUNT_USERNAME`/`DEMO_PROJECT_SLUG`. */
const DEMO_ROUTE = {
  username: DEMO_ACCOUNT_USERNAME,
  projectSlug: DEMO_PROJECT_SLUG,
};
const DEMO_PROJECT_PATH = `/${DEMO_ACCOUNT_USERNAME}/${DEMO_PROJECT_SLUG}`;
const DEMO_TOUR_PATH = `${DEMO_PROJECT_PATH}/tour`;

describe("ProjectConversionBanner", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({
      url: "https://app.scarn.io/alice/project-1/work-items",
    });

    Object.assign(globalThis, {
      location: dom.window.location,
      sessionStorage: dom.window.sessionStorage,
    });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          addEventListener() {},
          addListener() {},
          dispatchEvent() {
            return false;
          },
          matches: false,
          media: query,
          onchange: null,
          removeEventListener() {},
          removeListener() {},
        }) as MediaQueryList,
      writable: true,
    });

    mockPathname = "/alice/project-1/work-items";
    mockSearchParams = new URLSearchParams();
    dom.window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders nothing for a member viewer", () => {
    const view = renderBanner(true);
    expect(view.queryByText(/sign up/i)).toBeNull();
  });

  test("shows a conversion banner with a sign-up CTA for a non-member viewer", () => {
    const view = renderBanner(false);
    expect(view.getByText(GUEST_COPY)).toBeTruthy();
    const cta = view.getByRole("link", { name: /sign up/i });
    expect(cta.getAttribute("href")).toBe(
      "/login?callbackUrl=%2Falice%2Fproject-1%2Fwork-items",
    );
  });

  test("preserves the current page's query string in the sign-up callback URL", () => {
    mockSearchParams = new URLSearchParams({ page: "2" });

    const view = renderBanner(false);

    const cta = view.getByRole("link", { name: /sign up/i });
    expect(cta.getAttribute("href")).toBe(
      "/login?callbackUrl=%2Falice%2Fproject-1%2Fwork-items%3Fpage%3D2",
    );
  });

  test("dismissing the banner hides it and persists the dismissal for the rest of the session", () => {
    const view = renderBanner(false);

    fireEvent.click(view.getByRole("button", { name: /dismiss/i }));

    expect(view.queryByText(GUEST_COPY)).toBeNull();
    expect(
      dom.window.sessionStorage.getItem(
        `scarn:conversion-banner-dismissed:${PROJECT_ID}`,
      ),
    ).toBe("1");
  });

  test("stays hidden across a remount of the same project within the same session", () => {
    dom.window.sessionStorage.setItem(
      `scarn:conversion-banner-dismissed:${PROJECT_ID}`,
      "1",
    );

    const view = renderBanner(false);

    expect(view.queryByText(GUEST_COPY)).toBeNull();
  });

  test("does not suppress the banner on a different public project's session dismissal", () => {
    dom.window.sessionStorage.setItem(
      `scarn:conversion-banner-dismissed:${OTHER_PROJECT_ID}`,
      "1",
    );

    const view = renderBanner(false, PROJECT_ID);

    expect(view.getByText(GUEST_COPY)).toBeTruthy();
  });

  test("keeps the generic copy verbatim on a non-demo project", () => {
    const view = renderBanner(false);

    expect(view.getByText(GUEST_COPY).textContent).toBe(
      "You\u2019re viewing this project as a guest. Sign up to create and manage your own projects.",
    );
    expect(view.queryByText(DEMO_COPY)).toBeNull();
    expect(view.queryByRole("link", { name: /see the run/i })).toBeNull();
  });

  test("swaps in demo copy and a payoff CTA to the project Overview on the demo project", () => {
    mockPathname = `${DEMO_PROJECT_PATH}/work-items`;

    const view = renderBanner(false, PROJECT_ID, DEMO_ROUTE);

    expect(view.getByText(DEMO_COPY).textContent).toContain(
      "a real agent reproducing a real checkout bug in a real browser",
    );
    expect(view.queryByText(GUEST_COPY)).toBeNull();

    const payoff = view.getByRole("link", { name: /see the run/i });
    expect(payoff.getAttribute("href")).toBe(DEMO_TOUR_PATH);

    // The banner's job is still conversion: sign-up survives alongside.
    const signUp = view.getByRole("link", { name: /sign up/i });
    expect(signUp.getAttribute("href")).toBe(
      `/login?callbackUrl=${encodeURIComponent(`${DEMO_PROJECT_PATH}/work-items`)}`,
    );
  });

  test("drops the payoff CTA when the demo's Overview page is already on screen", () => {
    mockPathname = DEMO_TOUR_PATH;

    const view = renderBanner(false, PROJECT_ID, DEMO_ROUTE);

    expect(view.getByText(DEMO_COPY)).toBeTruthy();
    expect(view.queryByRole("link", { name: /see the run/i })).toBeNull();
    expect(view.getByRole("link", { name: /sign up/i })).toBeTruthy();
  });

  test("keeps the generic copy when only the slug matches the demo project", () => {
    mockPathname = `/alice/${DEMO_PROJECT_SLUG}/work-items`;

    const view = renderBanner(false, PROJECT_ID, {
      username: "alice",
      projectSlug: DEMO_PROJECT_SLUG,
    });

    expect(view.getByText(GUEST_COPY)).toBeTruthy();
    expect(view.queryByText(DEMO_COPY)).toBeNull();
    expect(view.queryByRole("link", { name: /see the run/i })).toBeNull();
  });

  test("keeps the generic copy when only the username matches the demo account", () => {
    mockPathname = `/${DEMO_ACCOUNT_USERNAME}/side-project/work-items`;

    const view = renderBanner(false, PROJECT_ID, {
      username: DEMO_ACCOUNT_USERNAME,
      projectSlug: "side-project",
    });

    expect(view.getByText(GUEST_COPY)).toBeTruthy();
    expect(view.queryByText(DEMO_COPY)).toBeNull();
  });

  test("renders nothing for a member viewing the demo project", () => {
    mockPathname = DEMO_TOUR_PATH;

    const view = renderBanner(true, PROJECT_ID, DEMO_ROUTE);

    expect(view.queryByText(DEMO_COPY)).toBeNull();
    expect(view.queryByRole("link", { name: /sign up/i })).toBeNull();
  });

  test("dismissal still works on the demo project", () => {
    mockPathname = `${DEMO_PROJECT_PATH}/work-items`;

    const view = renderBanner(false, PROJECT_ID, DEMO_ROUTE);

    fireEvent.click(view.getByRole("button", { name: /dismiss/i }));

    expect(view.queryByText(DEMO_COPY)).toBeNull();
    expect(view.queryByRole("link", { name: /see the run/i })).toBeNull();
    expect(
      dom.window.sessionStorage.getItem(
        `scarn:conversion-banner-dismissed:${PROJECT_ID}`,
      ),
    ).toBe("1");
  });
});
