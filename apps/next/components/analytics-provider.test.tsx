import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import { posthogTestMock } from "@scarn/observability/analytics/test-mocks/posthog-browser";
import { installDom } from "@/tests/support/install-dom";

let mockPathname: string | null = "/";
let mockSearch = "";

void mock.module("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const { AnalyticsProvider } = await import("./analytics-provider");

const ORIGINAL_KEY = process.env["NEXT_PUBLIC_POSTHOG_KEY"];
const ORIGINAL_HOST = process.env["NEXT_PUBLIC_POSTHOG_HOST"];

describe("AnalyticsProvider", () => {
  let dom: JSDOM;

  beforeAll(() => {
    dom = installDom({ url: "https://app.scarn.io/" });

    process.env["NEXT_PUBLIC_POSTHOG_KEY"] = "phc_test";
    process.env["NEXT_PUBLIC_POSTHOG_HOST"] = "https://t.scarn.io";
  });

  beforeEach(() => {
    posthogTestMock.capture.mockClear();
    mockPathname = "/dashboard";
    mockSearch = "";
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    dom.window.close();
    if (ORIGINAL_KEY === undefined) {
      delete process.env["NEXT_PUBLIC_POSTHOG_KEY"];
    } else {
      process.env["NEXT_PUBLIC_POSTHOG_KEY"] = ORIGINAL_KEY;
    }
    if (ORIGINAL_HOST === undefined) {
      delete process.env["NEXT_PUBLIC_POSTHOG_HOST"];
    } else {
      process.env["NEXT_PUBLIC_POSTHOG_HOST"] = ORIGINAL_HOST;
    }
  });

  test("fires a pageView for the current pathname on mount", async () => {
    mockPathname = "/dashboard";
    mockSearch = "";

    render(
      <AnalyticsProvider>
        <div />
      </AnalyticsProvider>,
    );

    await waitFor(() => {
      expect(posthogTestMock.capture).toHaveBeenCalledWith("$pageview", {
        $current_url: "https://app.scarn.io/dashboard",
      });
    });
  });

  test("includes the query string in the tracked url", async () => {
    mockPathname = "/projects/abc/work-items";
    mockSearch = "filter=open&sort=desc";

    render(
      <AnalyticsProvider>
        <div />
      </AnalyticsProvider>,
    );

    await waitFor(() => {
      expect(posthogTestMock.capture).toHaveBeenCalledWith("$pageview", {
        $current_url:
          "https://app.scarn.io/projects/abc/work-items?filter=open&sort=desc",
      });
    });
  });

  test("renders children", () => {
    const view = render(
      <AnalyticsProvider>
        <div data-testid="child">hello</div>
      </AnalyticsProvider>,
    );

    expect(view.getByTestId("child").textContent).toBe("hello");
  });
});
