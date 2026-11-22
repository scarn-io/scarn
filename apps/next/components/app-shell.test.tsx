import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { JSDOM } from "jsdom";
import { posthogTestMock } from "@scarn/observability/analytics/test-mocks/posthog-browser";
import { installDom } from "@/tests/support/install-dom";

let mockSession: {
  user: {
    id: string;
    email: string;
    username: string;
    name: string;
    image: string | null;
  };
} | null = null;

const signOutMock = mock(async () => {});
const identifyMock = mock(() => {});
const resetMock = mock(() => {});

void mock.module("next/image", () => ({
  default: ({ alt, src }: { alt?: string; src?: string | { src: string } }) => (
    <span
      data-alt={alt}
      data-src={typeof src === "string" ? src : src?.src}
      data-testid="mock-next-image"
    />
  ),
}));

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: mockSession }),
    signOut: signOutMock,
  },
}));

void mock.module("@scarn/observability/analytics/browser", () => ({
  init: ({
    key,
    host,
    uiHost,
  }: {
    key: string;
    host: string;
    uiHost?: string;
  }) => {
    posthogTestMock.init(key, {
      api_host: host,
      ui_host: uiHost,
      capture_pageview: false,
      capture_exceptions: true,
      persistence: "localStorage+cookie",
    });
    return true;
  },
  pageView: (url: string) => {
    posthogTestMock.capture("$pageview", { $current_url: url });
  },
  identify: identifyMock,
  reset: resetMock,
}));

const { AppShell } = await import("./app-shell");
const { getUserInitials } = await import("./user-initials");

describe("AppShell", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/" });

    const browserImage = dom.window[
      "Image"
    ] as unknown as (typeof globalThis)["Image"];

    Object.assign(globalThis, {
      Image: browserImage,
      location: dom.window.location,
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

    identifyMock.mockClear();
    resetMock.mockClear();
    signOutMock.mockClear();
    mockSession = {
      user: {
        id: "user-1",
        email: "pam.beesly@example.com",
        username: "pam-beesly",
        name: "Pam Beesly",
        image: null,
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("falls back to user initials and opens the sign-out menu from the profile button", async () => {
    const view = render(
      <AppShell>
        <div>content</div>
      </AppShell>,
    );

    expect(view.getByText("PB")).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: "Sign out" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Open profile menu" }));

    const signOutMenuItem = await within(document.body).findByRole("menuitem", {
      name: "Sign out",
    });
    expect(signOutMenuItem).toBeTruthy();
    expect(within(document.body).getByText("Pam Beesly")).toBeTruthy();
    expect(
      within(document.body).getByText("pam.beesly@example.com"),
    ).toBeTruthy();
  });

  test("renders the user's real profile image when available", () => {
    mockSession = {
      user: {
        id: "user-1",
        email: "pam.beesly@example.com",
        username: "pam-beesly",
        name: "Pam Beesly",
        image: "https://cdn.example.com/pam.png",
      },
    };

    const view = render(
      <AppShell>
        <div>content</div>
      </AppShell>,
    );

    const avatarImage = view.getByAltText("Pam Beesly");
    expect(avatarImage.getAttribute("src")).toContain("pam.png");
  });

  test("uses the initial server user while the client session is loading", () => {
    mockSession = null;

    const view = render(
      <AppShell
        initialUser={{
          id: "018f1d9f-4b88-7f2b-9a7a-123456789abc",
          email: "owner-e2e2@example.com",
          username: "owner-e2e2",
          name: "Owner E2E2",
          image: null,
        }}
      >
        <div>content</div>
      </AppShell>,
    );

    expect(view.getByText("OE")).toBeTruthy();
    expect(view.queryByText("?")).toBeNull();
  });

  test("shows a Log in link instead of the profile menu for an anonymous viewer", () => {
    mockSession = null;

    const view = render(
      <AppShell initialUser={null}>
        <div>content</div>
      </AppShell>,
    );

    expect(view.getByRole("link", { name: "Log in" })).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Open profile menu" }),
    ).toBeNull();
  });
});

describe("getUserInitials", () => {
  test("derives initials from the username first, then the name, never the email", () => {
    // Username wins, with hyphens/underscores treated as word separators.
    expect(getUserInitials("pam-beesly", "Pam Beesly")).toBe("PB");
    expect(getUserInitials("quiet_fox", null)).toBe("QF");
    expect(getUserInitials("solo", null)).toBe("SO");
    // Falls back to the display name when there is no username.
    expect(getUserInitials(null, "Pam Beesly")).toBe("PB");
    // No email fallback: nothing usable resolves to "?".
    expect(getUserInitials(null, null)).toBe("?");
    expect(getUserInitials("", "")).toBe("?");
  });
});
