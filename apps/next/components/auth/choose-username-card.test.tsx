import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "@/tests/support/install-dom";

type AvailabilityResult = {
  data: { valid: boolean; available: boolean } | null;
  error: unknown;
};

let availabilityResult: AvailabilityResult = {
  data: { valid: true, available: true },
  error: null,
};

const availableGetMock = mock(() => Promise.resolve(availabilityResult));
const usernamePostMock = mock(() =>
  Promise.resolve({ data: { username: "octocat" }, error: null }),
);

void mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {} }),
}));

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      username: {
        post: usernamePostMock,
        available: { get: availableGetMock },
      },
    },
  }),
}));

const { ChooseUsernameCard } = await import("./choose-username-card");

function setupDom() {
  const dom = installDom({ url: "http://localhost/onboarding/username" });

  type WithIeEvents = { attachEvent?: () => void; detachEvent?: () => void };
  for (const prototype of [
    dom.window.HTMLInputElement.prototype,
    dom.window.Element.prototype,
  ]) {
    (prototype as unknown as WithIeEvents).attachEvent = () => {};
    (prototype as unknown as WithIeEvents).detachEvent = () => {};
  }
}

describe("ChooseUsernameCard", () => {
  beforeEach(() => {
    setupDom();
    availableGetMock.mockClear();
    usernamePostMock.mockClear();
    availabilityResult = {
      data: { valid: true, available: true },
      error: null,
    };
  });

  afterEach(() => {
    cleanup();
  });

  test("checks a prefilled suggestion on mount", async () => {
    const view = render(
      <ChooseUsernameCard callbackUrl="/" initialUsername="octocat" />,
    );

    expect(view.getByLabelText("Username")).toHaveProperty("value", "octocat");
    expect(availableGetMock).toHaveBeenCalledTimes(1);
    expect(availableGetMock).toHaveBeenCalledWith({
      query: { u: "octocat" },
    });
    await waitFor(() => {
      expect(view.getByText("This username is available.")).toBeDefined();
    });
    expect(
      view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("keeps submit enabled when the availability check fails", async () => {
    availabilityResult = { data: null, error: { status: 500 } };
    const view = render(
      <ChooseUsernameCard
        callbackUrl="/onboarding/username#saved"
        initialUsername="octocat"
      />,
    );

    await waitFor(() => {
      expect(
        view.getByText("Couldn't check availability — you can still continue."),
      ).toBeDefined();
    });
    const continueButton = view.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(continueButton);
    await waitFor(() => {
      expect(usernamePostMock).toHaveBeenCalledWith({ username: "octocat" });
    });
  });

  test("disables submit when the username is taken", async () => {
    availabilityResult = {
      data: { valid: true, available: false },
      error: null,
    };
    const view = render(
      <ChooseUsernameCard callbackUrl="/" initialUsername="octocat" />,
    );

    await waitFor(() => {
      expect(view.getByText("This username is already taken.")).toBeDefined();
    });
    expect(
      view.getByRole("button", { name: "Continue" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("starts empty without checking when there is no suggestion", () => {
    const view = render(<ChooseUsernameCard callbackUrl="/" />);

    expect(view.getByLabelText("Username")).toHaveProperty("value", "");
    expect(availableGetMock).not.toHaveBeenCalled();
  });
});
