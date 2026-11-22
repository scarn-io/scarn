import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiKeysPanel,
  apiState,
  buildKey,
  cleanup,
  defaultExpiryDate,
  fillForm,
  fireEvent,
  isFutureDate,
  render,
  resetApiState,
  saveButton,
  waitFor,
  within,
} from "./api-keys-panel-test-support";

describe("ApiKeysPanel", () => {
  beforeEach(() => {
    resetApiState();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists saved Jira keys with provider, email, last four, status, and last used", async () => {
    apiState.listResult = {
      data: [
        buildKey(),
        buildKey({
          id: "0198f2c4-0000-7000-8000-000000000002",
          name: "Side project",
          lastFour: "zz99",
          status: "expiring_soon",
          lastUsedAt: "2026-10-01T00:00:00.000Z",
        }),
        buildKey({
          id: "0198f2c4-0000-7000-8000-000000000003",
          name: "Old",
          status: "expired",
        }),
      ],
      error: null,
    };
    const view = render(<ApiKeysPanel />);

    const work = await view.findByRole("listitem", {
      name: "API key Work Jira",
    });
    expect(apiState.listCalls).toEqual([undefined]);
    expect(within(work).getByText("Jira")).toBeTruthy();
    expect(within(work).getByText("work@acme.test · ••••ab12")).toBeTruthy();
    expect(within(work).getByText("Active")).toBeTruthy();
    expect(within(work).getByText(/Never used/)).toBeTruthy();

    const side = view.getByRole("listitem", { name: "API key Side project" });
    expect(within(side).getByText("Expiring soon")).toBeTruthy();
    expect(within(side).getByText(/Last used/)).toBeTruthy();

    const old = view.getByRole("listitem", { name: "API key Old" });
    expect(within(old).getAllByText(/Expired/).length).toBeGreaterThan(0);
  });

  test("never says 'secret' in the UI", async () => {
    apiState.listResult = { data: [buildKey()], error: null };
    const view = render(<ApiKeysPanel />);

    await view.findByRole("listitem", { name: "API key Work Jira" });
    expect(view.container.textContent.toLowerCase()).not.toContain("secret");
  });

  test("shows an empty state when there are no keys", async () => {
    const view = render(<ApiKeysPanel />);

    expect(await view.findByText("No saved API keys yet.")).toBeTruthy();
  });

  test("the add form links to Atlassian, masks the token, and defaults expiry to a year out", async () => {
    const view = render(<ApiKeysPanel />);
    await view.findByText("No saved API keys yet.");

    const link = view.getByRole("link", { name: "Atlassian API tokens page" });
    expect(link.getAttribute("href")).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
    expect(
      view.getAllByText(/match the (expiry )?date/i).length,
    ).toBeGreaterThan(0);
    const token = view.getByLabelText("API token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.getAttribute("autocomplete")).toBe("off");
    expect((view.getByLabelText("Expiry date") as HTMLInputElement).value).toBe(
      defaultExpiryDate(),
    );
    expect(saveButton(view).disabled).toBe(true);
  });

  test("an expiry date in the past disables saving", async () => {
    const view = render(<ApiKeysPanel />);
    await view.findByText("No saved API keys yet.");

    fillForm(view, {
      name: "Work Jira",
      email: "work@acme.test",
      token: "tok-1234",
      expiry: "2020-01-01",
    });

    expect(view.getByText("Pick a date in the future.")).toBeTruthy();
    expect(saveButton(view).disabled).toBe(true);
  });

  test("saving posts the key, adds it to the list, and clears the token", async () => {
    const created = buildKey({ name: "New key", lastFour: "1234" });
    apiState.createResult = { data: created, error: null };
    const view = render(<ApiKeysPanel />);
    await view.findByText("No saved API keys yet.");

    fillForm(view, {
      name: " New key ",
      email: "work@acme.test",
      token: "tok-1234",
      expiry: "2099-03-15",
    });
    fireEvent.click(saveButton(view));

    expect((view.getByLabelText("API token") as HTMLInputElement).value).toBe(
      "",
    );
    await view.findByRole("listitem", { name: "API key New key" });
    expect(apiState.createCalls).toHaveLength(1);
    expect(apiState.createCalls[0]).toMatchObject({
      kind: "jira_api_key",
      name: "New key",
      email: "work@acme.test",
      value: "tok-1234",
    });
    const expiresAt = new Date(
      apiState.createCalls[0]?.["expiresAt"] as string,
    );
    expect(expiresAt.getFullYear()).toBe(2099);
    expect(expiresAt.getMonth()).toBe(2);
    expect(expiresAt.getDate()).toBe(15);
  });

  test("a failed save shows the error and still clears the token", async () => {
    apiState.createResult = {
      data: null,
      error: {
        value: { status: 409, detail: "You already have a key named that." },
      },
    };
    const view = render(<ApiKeysPanel />);
    await view.findByText("No saved API keys yet.");

    fillForm(view, {
      name: "Work Jira",
      email: "work@acme.test",
      token: "tok-1234",
    });
    fireEvent.click(saveButton(view));

    expect(
      await view.findByText("You already have a key named that."),
    ).toBeTruthy();
    expect((view.getByLabelText("API token") as HTMLInputElement).value).toBe(
      "",
    );
    expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Work Jira",
    );
  });

  test("renaming sends { name } and updates the row", async () => {
    const key = buildKey();
    apiState.listResult = { data: [key], error: null };
    apiState.renameResult = { data: { ...key, name: "Renamed" }, error: null };
    const view = render(<ApiKeysPanel />);
    await view.findByRole("listitem", { name: "API key Work Jira" });

    fireEvent.click(view.getByRole("button", { name: "Rename Work Jira" }));
    const dialog = view.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await view.findByRole("listitem", { name: "API key Renamed" });
    expect(apiState.renameCalls).toEqual([
      { secretId: key.id, body: { name: "Renamed" } },
    ]);
  });

  test("delete asks for confirmation before removing the key", async () => {
    const key = buildKey();
    apiState.listResult = { data: [key], error: null };
    const view = render(<ApiKeysPanel />);
    await view.findByRole("listitem", { name: "API key Work Jira" });

    fireEvent.click(view.getByRole("button", { name: "Delete Work Jira" }));
    const dialog = view.getByRole("dialog");
    expect(within(dialog).getByText('Delete "Work Jira"?')).toBeTruthy();
    expect(apiState.deleteCalls).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(
        view.queryByRole("listitem", { name: "API key Work Jira" }),
      ).toBeNull();
    });
    expect(apiState.deleteCalls).toEqual([key.id]);
  });

  test("cancelling the delete confirmation keeps the key", async () => {
    apiState.listResult = { data: [buildKey()], error: null };
    const view = render(<ApiKeysPanel />);
    await view.findByRole("listitem", { name: "API key Work Jira" });

    fireEvent.click(view.getByRole("button", { name: "Delete Work Jira" }));
    fireEvent.click(
      within(view.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );

    expect(apiState.deleteCalls).toEqual([]);
    expect(
      view.getByRole("listitem", { name: "API key Work Jira", hidden: true }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(apiState.deleteCalls).toEqual([]);
  });
});

describe("expiry helpers", () => {
  test("defaultExpiryDate is one year from the given day", () => {
    expect(defaultExpiryDate(new Date(2026, 9, 20))).toBe("2027-10-20");
  });

  test("isFutureDate accepts only dates after today", () => {
    const today = new Date(2026, 9, 20);
    expect(isFutureDate("2026-10-21", today)).toBe(true);
    expect(isFutureDate("2026-10-20", today)).toBe(false);
    expect(isFutureDate("2025-01-01", today)).toBe(false);
    expect(isFutureDate("", today)).toBe(false);
  });
});
