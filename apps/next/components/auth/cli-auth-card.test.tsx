import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";

type DeviceResult = { error: { error: string } | null };

const verifyMock = mock((): Promise<DeviceResult> =>
  Promise.resolve({ error: null }),
);
const approveMock = mock((): Promise<DeviceResult> =>
  Promise.resolve({ error: null }),
);
const denyMock = mock((): Promise<DeviceResult> =>
  Promise.resolve({ error: null }),
);

void mock.module("@/app/_lib/auth-client", () => ({
  authClient: {
    device: Object.assign(verifyMock, {
      approve: approveMock,
      deny: denyMock,
    }),
  },
}));

const { CliAuthCard, CLI_AUTH_APPROVED_MESSAGE, CLI_AUTH_DENIED_MESSAGE } =
  await import("./cli-auth-card");

function setupDom() {
  const dom = installDom({ url: "http://localhost/cli-auth" });

  type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
  for (const prototype of [
    dom.window.HTMLInputElement.prototype,
    dom.window.Element.prototype,
  ]) {
    (prototype as unknown as WithIeEvents).attachEvent = () => {};
    (prototype as unknown as WithIeEvents).detachEvent = () => {};
  }
}

const buttonByText = (view: ReturnType<typeof render>, text: string) => {
  const button = view.getByText(text).closest("button");
  if (!button) throw new Error(`No button labelled ${text}`);
  return button;
};

describe("CliAuthCard", () => {
  beforeEach(() => {
    setupDom();
    verifyMock.mockClear();
    approveMock.mockClear();
    denyMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("approves the code after verifying it, then locks the form", async () => {
    const view = render(<CliAuthCard initialUserCode="ABCD1234" />);

    fireEvent.click(buttonByText(view, "Approve CLI access"));

    await waitFor(() => {
      expect(view.getByText(CLI_AUTH_APPROVED_MESSAGE)).toBeTruthy();
    });
    expect(verifyMock).toHaveBeenCalledWith({
      query: { user_code: "ABCD1234" },
    });
    expect(approveMock).toHaveBeenCalledWith({ userCode: "ABCD1234" });
    expect(denyMock).not.toHaveBeenCalled();
    expect(buttonByText(view, "Approve CLI access").disabled).toBe(true);
    expect(buttonByText(view, "Deny").disabled).toBe(true);
    expect(view.getByLabelText(/CLI code/)).toHaveProperty("disabled", true);
  });

  test("denies the code after verifying it, then locks the form", async () => {
    const view = render(<CliAuthCard initialUserCode="abcd-1234" />);

    fireEvent.click(buttonByText(view, "Deny"));

    await waitFor(() => {
      expect(view.getByText(CLI_AUTH_DENIED_MESSAGE)).toBeTruthy();
    });
    expect(verifyMock).toHaveBeenCalledWith({
      query: { user_code: "ABCD1234" },
    });
    expect(denyMock).toHaveBeenCalledWith({ userCode: "ABCD1234" });
    expect(approveMock).not.toHaveBeenCalled();
    expect(buttonByText(view, "Approve CLI access").disabled).toBe(true);
    expect(buttonByText(view, "Deny").disabled).toBe(true);
  });

  test("keeps the form usable when the code fails verification", async () => {
    verifyMock.mockImplementationOnce(() =>
      Promise.resolve({ error: { error: "invalid_request" } }),
    );
    const view = render(<CliAuthCard initialUserCode="ABCD1234" />);

    fireEvent.click(buttonByText(view, "Approve CLI access"));

    await waitFor(() => {
      expect(
        view.getByText("That CLI sign-in code is invalid or has expired."),
      ).toBeTruthy();
    });
    expect(approveMock).not.toHaveBeenCalled();
    expect(buttonByText(view, "Approve CLI access").disabled).toBe(false);
  });
});
