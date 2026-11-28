import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  parseUuidV7,
  type ArtifactShareContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

const dom = installDom();
const clipboardWrites: string[] = [];

Object.defineProperty(dom.window.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: (text: string) => {
      clipboardWrites.push(text);
      return Promise.resolve();
    },
  },
});

const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ArtifactSharePanel } = await import("./artifact-share-panel");

const EXPIRES_AT = "2026-12-20T12:00:00.000Z";
const SHARE_URL = "https://content.example.test/s/sh1.abc/";

function buildShare(
  overrides: Partial<ArtifactShareContract> = {},
): ArtifactShareContract {
  return {
    bundleId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa901"),
    status: "private",
    reason: null,
    url: null,
    expiresAt: EXPIRES_AT,
    shareDeclared: false,
    share: null,
    ...overrides,
  };
}

const sharedShare = buildShare({
  status: "shared",
  url: SHARE_URL,
  share: {
    id: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa902"),
    createdVia: "person",
    createdAt: "2026-11-20T12:00:00.000Z",
  },
});

describe("ArtifactSharePanel", () => {
  const onShare = mock(() => Promise.resolve());
  const onRevoke = mock(() => Promise.resolve());

  const renderPanel = (
    share: ArtifactShareContract,
    extra: { busy?: boolean; error?: string; canManage?: boolean } = {},
  ) =>
    render(
      <ArtifactSharePanel
        share={share}
        busy={extra.busy ?? false}
        error={extra.error ?? ""}
        canManage={extra.canManage}
        onShare={onShare}
        onRevoke={onRevoke}
      />,
    );

  beforeEach(() => {
    clipboardWrites.length = 0;
    onShare.mockClear();
    onRevoke.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("private: shows Private and shares on click", () => {
    const view = renderPanel(buildShare());
    expect(view.getByText("Private")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Share" }));
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("button", { name: "Revoke link" })).toBeNull();
  });

  test("private after a revoke of a declared share is still just private", () => {
    const view = renderPanel(buildShare({ shareDeclared: true }));
    expect(view.getByText("Private")).toBeTruthy();
    expect(view.getByRole("button", { name: "Share" })).toBeTruthy();
  });

  test("shared: shows the link, copies it and warns about public access", async () => {
    const view = renderPanel(sharedShare);
    expect(view.getByText("Shared")).toBeTruthy();
    expect(view.getByText(SHARE_URL)).toBeTruthy();
    expect(
      view.getByText(
        `Anyone with this link can view this bundle. It expires on ${new Date(EXPIRES_AT).toLocaleString()}.`,
      ),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Share" })).toBeNull();

    fireEvent.click(view.getByLabelText("Copy share link"));
    await waitFor(() => {
      expect(clipboardWrites).toEqual([SHARE_URL]);
    });
  });

  test("shared: Revoke link asks for confirmation before revoking", async () => {
    const view = renderPanel(sharedShare);
    fireEvent.click(view.getByRole("button", { name: "Revoke link" }));
    expect(onRevoke).not.toHaveBeenCalled();

    const dialog = await view.findByRole("dialog");
    expect(dialog.textContent).toContain("Revoke this link?");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent === "Revoke link",
    );
    if (!confirm) throw new Error("No confirm button in the dialog");
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(onRevoke).toHaveBeenCalledTimes(1);
    });
  });

  test("hides Share and Revoke when the viewer can't manage the link", () => {
    const privateView = renderPanel(buildShare(), { canManage: false });
    expect(privateView.queryByRole("button", { name: "Share" })).toBeNull();
    cleanup();
    const sharedView = renderPanel(sharedShare, { canManage: false });
    expect(
      sharedView.queryByRole("button", { name: "Revoke link" }),
    ).toBeNull();
    expect(sharedView.getByText(SHARE_URL)).toBeTruthy();
  });

  test("expired: says so and offers no share or copy", () => {
    const view = renderPanel(buildShare({ status: "expired" }));
    expect(
      view.getByText("This bundle has expired, so it can't be shared."),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Share" })).toBeNull();
    expect(view.queryByLabelText("Copy share link")).toBeNull();
  });

  test("deleted: says the bundle was deleted", () => {
    const view = renderPanel(buildShare({ status: "deleted" }));
    expect(
      view.getByText("This bundle was deleted, so it can't be shared."),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Share" })).toBeNull();
  });

  test("unavailable: says sharing is off on this server", () => {
    const view = renderPanel(
      buildShare({ status: "unavailable", reason: "sharing_disabled" }),
    );
    expect(view.getByText("Sharing is off on this server.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Share" })).toBeNull();
  });

  test("unavailable with a declared share: says it would be shared", () => {
    const view = renderPanel(
      buildShare({
        status: "unavailable",
        reason: "sharing_disabled",
        shareDeclared: true,
      }),
    );
    expect(
      view.getByText(
        "This bundle would be shared; sharing is off on this server.",
      ),
    ).toBeTruthy();
  });

  test("shows the action error", () => {
    const view = renderPanel(buildShare(), {
      error: "You don't have permission to do this.",
    });
    expect(view.getByRole("alert").textContent).toBe(
      "You don't have permission to do this.",
    );
  });
});
