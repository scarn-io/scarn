import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ApiKeysPanel,
  apiState,
  buildKey,
  cleanup,
  fireEvent,
  render,
  resetApiState,
  waitFor,
  within,
} from "./api-keys-panel-test-support";
import type { SecretUseContract } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";

const acmeUse: SecretUseContract = {
  projectId: parseUuidV7("0198f2c4-0000-7000-8000-0000000000a1"),
  projectName: "Acme Web",
  integrationId: parseUuidV7("0198f2c4-0000-7000-8000-0000000000b1"),
  platform: "jira",
};

const billingUse: SecretUseContract = {
  projectId: parseUuidV7("0198f2c4-0000-7000-8000-0000000000a2"),
  projectName: "Billing",
  integrationId: parseUuidV7("0198f2c4-0000-7000-8000-0000000000b2"),
  platform: "jira",
};

describe("ApiKeysPanel used-by", () => {
  beforeEach(() => {
    resetApiState();
  });

  afterEach(() => {
    cleanup();
  });

  test("lists each project integration the key is used by", async () => {
    apiState.listResult = {
      data: [buildKey({ usedBy: [acmeUse, billingUse] })],
      error: null,
    };
    const view = render(<ApiKeysPanel />);

    const row = await view.findByRole("listitem", {
      name: "API key Work Jira",
    });
    expect(within(row).getByText("Used by: Acme Web auto-sync")).toBeTruthy();
    expect(within(row).getByText("Used by: Billing auto-sync")).toBeTruthy();
  });

  test("a key with no uses shows no used-by lines", async () => {
    apiState.listResult = { data: [buildKey()], error: null };
    const view = render(<ApiKeysPanel />);

    const row = await view.findByRole("listitem", {
      name: "API key Work Jira",
    });
    expect(within(row).queryByText(/Used by:/)).toBeNull();
    expect(
      within(row).queryByRole("button", { name: /Stop using/ }),
    ).toBeNull();
  });

  test("Stop using calls the API and replaces the row with the returned key", async () => {
    const key = buildKey({ usedBy: [acmeUse, billingUse] });
    apiState.listResult = { data: [key], error: null };
    apiState.stopUsingResult = {
      data: { ...key, usedBy: [billingUse] },
      error: null,
    };
    const view = render(<ApiKeysPanel />);
    await view.findByText("Used by: Acme Web auto-sync");

    fireEvent.click(
      view.getByRole("button", {
        name: "Stop using Work Jira for Acme Web auto-sync",
      }),
    );

    await waitFor(() => {
      expect(view.queryByText("Used by: Acme Web auto-sync")).toBeNull();
    });
    expect(view.getByText("Used by: Billing auto-sync")).toBeTruthy();
    expect(apiState.stopUsingCalls).toEqual([
      { secretId: key.id, integrationId: acmeUse.integrationId },
    ]);
  });

  test("a failed Stop using shows the error and keeps the entry", async () => {
    apiState.listResult = {
      data: [buildKey({ usedBy: [acmeUse] })],
      error: null,
    };
    apiState.stopUsingResult = {
      data: null,
      error: { value: { status: 409, detail: "That key isn't used there." } },
    };
    const view = render(<ApiKeysPanel />);
    await view.findByText("Used by: Acme Web auto-sync");

    fireEvent.click(
      view.getByRole("button", {
        name: "Stop using Work Jira for Acme Web auto-sync",
      }),
    );

    expect(await view.findByText("That key isn't used there.")).toBeTruthy();
    expect(view.getByText("Used by: Acme Web auto-sync")).toBeTruthy();
  });

  test("the delete confirmation names the integrations that will pause", async () => {
    apiState.listResult = {
      data: [buildKey({ usedBy: [acmeUse, billingUse] })],
      error: null,
    };
    const view = render(<ApiKeysPanel />);
    await view.findByRole("listitem", { name: "API key Work Jira" });

    fireEvent.click(view.getByRole("button", { name: "Delete Work Jira" }));

    const dialog = view.getByRole("dialog");
    expect(
      within(dialog).getByText("Auto-sync will pause for: Acme Web, Billing."),
    ).toBeTruthy();
  });

  test("the delete confirmation says nothing about auto-sync when unused", async () => {
    apiState.listResult = { data: [buildKey()], error: null };
    const view = render(<ApiKeysPanel />);
    await view.findByRole("listitem", { name: "API key Work Jira" });

    fireEvent.click(view.getByRole("button", { name: "Delete Work Jira" }));

    const dialog = view.getByRole("dialog");
    expect(within(dialog).queryByText(/Auto-sync will pause/)).toBeNull();
  });
});
