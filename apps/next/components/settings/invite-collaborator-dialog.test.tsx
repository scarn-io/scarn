import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PROJECT_ROLES } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// ─── API client mock ──────────────────────────────────────────────────────────

let mockPostResult: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const postMock = mock(() => Promise.resolve(mockPostResult));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      projects: () => ({
        invites: {
          post: postMock,
        },
      }),
    },
  }),
}));

const { InviteCollaboratorDialog } =
  await import("./invite-collaborator-dialog");

// ─── DOM setup helper ──────────────────────────────────────────────────────────

function setupDom() {
  const dom = installDom({ url: "http://localhost/" });

  Object.assign(globalThis, {
    navigator: Object.assign(Object.create(null), dom.window.navigator, {
      clipboard: { writeText: mock(() => Promise.resolve()) },
    }) as typeof navigator,
  });

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

  // Stub IE-only event methods that React 19's input polyfill tries to call.
  // JSDOM doesn't implement attachEvent/detachEvent; React checks for them and
  // would throw "is not a function" if they're truthy but non-callable.
  type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
  (
    dom.window.HTMLInputElement.prototype as unknown as WithIeEvents
  ).attachEvent = () => {};
  (
    dom.window.HTMLInputElement.prototype as unknown as WithIeEvents
  ).detachEvent = () => {};
  (dom.window.Element.prototype as unknown as WithIeEvents).attachEvent =
    () => {};
  (dom.window.Element.prototype as unknown as WithIeEvents).detachEvent =
    () => {};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("InviteCollaboratorDialog", () => {
  beforeEach(() => {
    setupDom();
    postMock.mockClear();
    mockPostResult = { data: null, error: null };
  });

  afterEach(() => {
    cleanup();
  });

  test("renders an option per project role with its description", () => {
    const view = render(
      <InviteCollaboratorDialog
        open
        projectId="proj-1"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
    );

    // Open the Role select to see options
    const roleCombobox = view.getByRole("combobox", { name: /role/i });
    fireEvent.mouseDown(roleCombobox);

    const options = document.querySelectorAll('[role="option"]');
    const optionTexts = Array.from(options).map((o) => [
      o.querySelector(".MuiListItemText-primary")?.textContent,
      o.querySelector(".MuiListItemText-secondary")?.textContent,
    ]);

    expect(optionTexts).toEqual(
      PROJECT_ROLES.map((role) => [role.label, role.description]),
    );
  });

  test("submit button is disabled until both email and role are filled", () => {
    const view = render(
      <InviteCollaboratorDialog
        open
        projectId="proj-1"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
    );

    const sendButton = view.getByRole("button", { name: /send invite/i });

    // Initially disabled
    expect(sendButton.hasAttribute("disabled")).toBe(true);

    // Fill email only — still disabled because role is empty
    fireEvent.change(view.getByRole("textbox", { name: /email address/i }), {
      target: { value: "user@example.com" },
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
  });

  test("unrestricted invite mode does not require an email address", () => {
    const view = render(
      <InviteCollaboratorDialog
        open
        projectId="proj-1"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
    );

    fireEvent.click(
      view.getByRole("radio", { name: /anyone with the link can claim it/i }),
    );

    const sendButton = view.getByRole("button", { name: /send invite/i });
    expect(view.queryByRole("textbox", { name: /email address/i })).toBeNull();
    expect(sendButton.hasAttribute("disabled")).toBe(true);

    fireEvent.mouseDown(view.getByRole("combobox", { name: /role/i }));
    fireEvent.click(document.querySelector('[role="option"]') as Element);

    expect(sendButton.hasAttribute("disabled")).toBe(false);
  });

  test("dialog renders the invite email input and role selector", () => {
    const view = render(
      <InviteCollaboratorDialog
        open
        projectId="proj-1"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
    );

    // Email field is present
    expect(view.getByRole("textbox", { name: /email address/i })).toBeTruthy();

    // Role selector is present and shows the label
    expect(view.getByRole("combobox", { name: /role/i })).toBeTruthy();

    // Dialog title is visible
    expect(view.getByText("Invite Collaborator")).toBeTruthy();
  });

  test("cancel button closes the dialog via onClose", () => {
    const onCloseMock = mock(() => {});
    const view = render(
      <InviteCollaboratorDialog
        open
        projectId="proj-1"
        onClose={onCloseMock}
        onInviteCreated={() => {}}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /cancel/i }));
    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });
});
