import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { JSDOM } from "jsdom";
import { installDom } from "@/tests/support/install-dom";

installDom({ url: "https://app.scarn.io/login" });

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {} }),
}));

type EmailCall = { kind: "sign-in" | "sign-up"; body: Record<string, unknown> };
const emailCalls: EmailCall[] = [];

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: {
    signIn: {
      social: () => Promise.resolve({ error: null }),
      email: (body: Record<string, unknown>) => {
        emailCalls.push({ kind: "sign-in", body });
        return Promise.resolve({
          error: { message: "Invalid email or password" },
        });
      },
    },
    signUp: {
      email: (body: Record<string, unknown>) => {
        emailCalls.push({ kind: "sign-up", body });
        return Promise.resolve({
          error: { message: "User already exists" },
        });
      },
    },
  },
}));

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { LoginCard } = await import("./login-card");

const renderCard = (overrides: Partial<Parameters<typeof LoginCard>[0]> = {}) =>
  render(
    <LoginCard
      callbackUrl="/"
      error={null}
      githubEnabled={true}
      googleEnabled={false}
      emailPasswordEnabled={false}
      devLoginEnabled={false}
      showProviderSetupHint={true}
      showDemoLink={false}
      {...overrides}
    />,
  );

describe("LoginCard", () => {
  let dom: JSDOM;

  beforeEach(() => {
    dom = installDom({ url: "https://app.scarn.io/login" });

    Object.assign(globalThis, {
      location: dom.window.location,
    });
  });

  afterEach(() => {
    cleanup();
    emailCalls.length = 0;
  });

  test("links a logged-out visitor straight to the read-only demo project when enabled", () => {
    const view = renderCard({ showDemoLink: true });

    const demoLink = view.getByRole("link", { name: "See the demo project" });
    expect(demoLink.getAttribute("href")).toBe("/scarn/demo/tour");
  });

  test("hides the demo project link when the deployment has not enabled it", () => {
    const view = renderCard();

    expect(
      view.queryByRole("link", { name: "See the demo project" }),
    ).toBeNull();
  });

  test("invites both new and returning users to sign in", () => {
    const view = renderCard({ callbackUrl: "/" });

    expect(view.getByText("Sign in or create your account")).toBeTruthy();
    expect(view.queryByText("Sign in to connect the Scarn CLI.")).toBeNull();
  });

  test("explains a CLI device-login handoff", () => {
    const view = renderCard({ callbackUrl: "/cli-auth?user_code=ABCD-EFGH" });

    expect(view.getByText("Sign in to connect the Scarn CLI.")).toBeTruthy();
  });

  test("explains an invite handoff", () => {
    const view = renderCard({ callbackUrl: "/invite/some-token" });

    expect(view.getByText("Sign in to accept your invite.")).toBeTruthy();
  });

  test("names the provider env vars outside production", () => {
    const view = renderCard({
      githubEnabled: false,
      showProviderSetupHint: true,
    });

    expect(
      view.getByText(/Set GITHUB_APP_CLIENT_\* or GOOGLE_OAUTH_\*/),
    ).toBeTruthy();
  });

  test("hides provider setup details in production", () => {
    const view = renderCard({
      githubEnabled: false,
      showProviderSetupHint: false,
    });

    expect(view.getByText("Sign-in is temporarily unavailable.")).toBeTruthy();
    expect(view.queryByText(/GITHUB_APP_CLIENT_/)).toBeNull();
  });

  test("hides the email form when email/password sign-in is off", () => {
    const view = renderCard();

    expect(view.queryByLabelText(/Password/)).toBeNull();
  });

  test("signs in with email and password when enabled", async () => {
    const view = renderCard({ emailPasswordEnabled: true });

    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: "ada@example.test" },
    });
    fireEvent.change(view.getByLabelText(/Password/), {
      target: { value: "correct horse" },
    });
    fireEvent.click(view.getByRole("button", { name: "Sign in with email" }));

    await waitFor(() => {
      expect(view.getByText("Invalid email or password")).toBeTruthy();
    });
    expect(emailCalls).toEqual([
      {
        kind: "sign-in",
        body: {
          email: "ada@example.test",
          password: "correct horse",
          callbackURL: "https://app.scarn.io/",
        },
      },
    ]);
  });

  test("switches to account creation and signs up with a name", async () => {
    const view = renderCard({ emailPasswordEnabled: true });

    fireEvent.click(
      view.getByRole("button", { name: "New here? Create an account" }),
    );
    fireEvent.change(view.getByLabelText(/Name/), {
      target: { value: "Ada" },
    });
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: "ada@example.test" },
    });
    fireEvent.change(view.getByLabelText(/Password/), {
      target: { value: "correct horse" },
    });
    fireEvent.click(view.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(emailCalls[0]?.kind).toBe("sign-up");
    });
    expect(emailCalls[0]?.body).toMatchObject({ name: "Ada" });
  });

  test("offers email sign-in on its own when no OAuth provider is configured", () => {
    const view = renderCard({
      githubEnabled: false,
      emailPasswordEnabled: true,
    });

    expect(
      view.getByText("Sign in with your email and password."),
    ).toBeTruthy();
    expect(view.queryByText(/No sign-in providers/)).toBeNull();
  });
});
