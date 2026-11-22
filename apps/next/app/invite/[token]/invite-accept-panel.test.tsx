import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";

// ─── Router & auth-client mocks ───────────────────────────────────────────────

const pushMock = mock(() => {});
void mock.module("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const signOutMock = mock(async () => {});
void mock.module("@/app/_lib/auth-client", () => ({
  authClient: { signOut: signOutMock },
}));

// ─── API client mock ──────────────────────────────────────────────────────────

let mockAcceptResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const acceptPostMock = mock(() => Promise.resolve(mockAcceptResult));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "project-invites": () => ({
        accept: { post: acceptPostMock },
      }),
    },
  }),
}));

const { InviteAcceptPanel } = await import("./invite-accept-panel");

// ─── Fixture ──────────────────────────────────────────────────────────────────

const baseInvite = {
  inviteId: "inv-1",
  projectId: "proj-1",
  projectName: "Acme Platform",
  projectSlug: "acme-platform",
  ownerUsername: "owner",
  role: "write" as const,
  restriction: "specific_email" as const,
  permissions: ["work-items:read", "work-items:write"],
  status: "pending" as const,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

// ─── DOM setup helper ─────────────────────────────────────────────────────────

function setupDom() {
  installDom({ url: "http://localhost/invite/testtoken" });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
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
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("InviteAcceptPanel", () => {
  beforeEach(() => {
    setupDom();
    acceptPostMock.mockClear();
    pushMock.mockClear();
    signOutMock.mockClear();
    mockAcceptResult = { data: null, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  test("renders sign-in CTA when signed out", () => {
    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={baseInvite}
        sessionUser={null}
      />,
    );

    expect(
      view.getByRole("button", { name: /sign in to accept/i }),
    ).toBeTruthy();
    // No accept button when signed out
    expect(view.queryByRole("button", { name: /accept invite/i })).toBeNull();
  });

  test("lists permissions as readable labels, falling back to the raw string", () => {
    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={{
          ...baseInvite,
          permissions: [
            "work-items:read",
            "work-items:write",
            "executions:create",
            "future-thing:launch",
          ],
        }}
        sessionUser={null}
      />,
    );

    expect(view.getByText("View work items")).toBeTruthy();
    expect(view.getByText("Edit work items")).toBeTruthy();
    expect(view.getByText("Create pipeline runs")).toBeTruthy();
    expect(view.getByText("future-thing:launch")).toBeTruthy();
    expect(view.queryByText("work-items:read")).toBeNull();
  });

  test("renders accept button when signed in", () => {
    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={baseInvite}
        sessionUser={{ email: "invitee@example.com" }}
      />,
    );

    expect(view.getByRole("button", { name: /accept invite/i })).toBeTruthy();
    // No sign-in CTA when already authenticated
    expect(
      view.queryByRole("button", { name: /sign in to accept/i }),
    ).toBeNull();
  });

  test("renders wrong-account warning with sign-out CTA after email mismatch", async () => {
    mockAcceptResult = {
      data: null,
      error: { value: { status: 403, detail: "Email mismatch" } },
    };

    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={baseInvite}
        sessionUser={{ email: "wronguser@example.com" }}
      />,
    );

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /accept invite/i }));
    });

    await waitFor(() => {
      expect(
        view.getByRole("button", { name: /sign out and try again/i }),
      ).toBeTruthy();
    });

    // Should show the signed-in email in the warning
    expect(document.body.textContent).toContain("wronguser@example.com");
  });

  test("does not show wrong-account warning for unrestricted invites", async () => {
    const unrestrictedInvite = {
      ...baseInvite,
      restriction: "any_authenticated_user" as const,
    };
    const acceptedInvite = {
      id: "inv-1",
      projectId: "proj-1",
      email: null,
      role: "write" as const,
      restriction: "any_authenticated_user" as const,
      permissions: [],
      invitedByUserId: "owner-1",
      status: "accepted" as const,
      expiresAt: baseInvite.expiresAt,
      acceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockAcceptResult = { data: acceptedInvite, error: null };

    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={unrestrictedInvite}
        sessionUser={{ email: "whoever@example.com" }}
      />,
    );

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /accept invite/i }));
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/owner/acme-platform/work-items");
    });
  });

  test("navigates to the project page after successful acceptance", async () => {
    const acceptedInvite = {
      id: "inv-1",
      projectId: "proj-1",
      email: "invitee@example.com",
      role: "write" as const,
      restriction: "specific_email" as const,
      permissions: [],
      invitedByUserId: "owner-1",
      status: "accepted" as const,
      expiresAt: baseInvite.expiresAt,
      acceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockAcceptResult = { data: acceptedInvite, error: null };

    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={baseInvite}
        sessionUser={{ email: "invitee@example.com" }}
      />,
    );

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /accept invite/i }));
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/owner/acme-platform/work-items");
    });
  });

  test("falls back to the dashboard when the owner username is unresolved", async () => {
    const acceptedInvite = {
      id: "inv-1",
      projectId: "proj-1",
      email: "invitee@example.com",
      role: "write" as const,
      restriction: "specific_email" as const,
      permissions: [],
      invitedByUserId: "owner-1",
      status: "accepted" as const,
      expiresAt: baseInvite.expiresAt,
      acceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockAcceptResult = { data: acceptedInvite, error: null };

    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={{ ...baseInvite, ownerUsername: null }}
        sessionUser={{ email: "invitee@example.com" }}
      />,
    );

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /accept invite/i }));
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/");
    });
  });

  test("shows an error message for non-403/non-401 failures", async () => {
    mockAcceptResult = {
      data: null,
      error: { value: { status: 500, detail: "Server exploded" } },
    };

    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={baseInvite}
        sessionUser={{ email: "invitee@example.com" }}
      />,
    );

    act(() => {
      fireEvent.click(view.getByRole("button", { name: /accept invite/i }));
    });

    await waitFor(() => {
      expect(view.getByRole("alert")).toBeTruthy();
    });
  });

  test("displays invite project name and role", () => {
    const view = render(
      <InviteAcceptPanel
        token="testtoken"
        invite={baseInvite}
        sessionUser={{ email: "invitee@example.com" }}
      />,
    );

    expect(view.getByText("Acme Platform")).toBeTruthy();
    // Role label should be rendered
    expect(document.body.textContent).toContain("Write");
  });
});
