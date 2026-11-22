import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  CONNECTION_ID,
  apiState,
  buildConnection,
  cleanup,
  dialog,
  fireEvent,
  renderPanel,
  resetHarness,
  waitFor,
  within,
} from "./project-mcp-connections-panel-test-support";

setDefaultTimeout(15_000);

/** Disconnecting from the panel: what the dialog and card say afterwards. */
describe("ProjectMcpConnectionsPanel disconnect", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    cleanup();
  });

  test("disconnect reports an accepted revocation and the removal link", async () => {
    apiState.deleteResult = {
      data: {
        connection: buildConnection({
          state: "disconnected",
          connectedBy: null,
          account: null,
          grantedScopes: [],
          reconnectBy: null,
          lastRevocation: {
            outcome: "accepted",
            at: "2026-11-17T12:00:00.000Z",
          },
        }),
        revocation: "accepted",
        providerRemovalUrl: "https://www.notion.so/profile/integrations",
      },
      error: null,
    };
    const view = renderPanel(buildConnection());

    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(dialog(view).getByRole("button", { name: "Disconnect" }));

    expect(
      await dialog(view).findByText(
        "Notion accepted Scarn's request to revoke this connection's access.",
      ),
    ).toBeTruthy();
    expect(
      dialog(view)
        .getByRole("link", { name: "Notion's connections settings" })
        .getAttribute("href"),
    ).toBe("https://www.notion.so/profile/integrations");
    fireEvent.click(dialog(view).getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(view.getByText("Not connected")).toBeTruthy();
    const card = within(
      view.getByRole("region", { name: "Notion connection" }),
    );
    expect(
      card.getByText(
        "Notion accepted Scarn's request to revoke this connection's access.",
      ),
    ).toBeTruthy();
    expect(
      card
        .getByRole("link", { name: "Notion's connections settings" })
        .getAttribute("href"),
    ).toBe("https://www.notion.so/profile/integrations");
    expect(apiState.calls).toEqual([
      { route: "delete", connectionId: CONNECTION_ID },
    ]);
  });

  test("disconnect shows no removal link when the connection's preset has none", async () => {
    apiState.deleteResult = {
      data: {
        connection: buildConnection({
          state: "disconnected",
          account: null,
          preset: null,
        }),
        revocation: "accepted",
        providerRemovalUrl: null,
      },
      error: null,
    };
    const view = renderPanel(buildConnection({ preset: null }));

    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(dialog(view).getByRole("button", { name: "Disconnect" }));

    expect(
      await dialog(view).findByText(
        "Notion accepted Scarn's request to revoke this connection's access.",
      ),
    ).toBeTruthy();
    expect(
      view.queryByRole("link", { name: /connections settings/ }),
    ).toBeNull();
  });

  test("disconnect never claims an unconfirmed revocation happened", async () => {
    apiState.deleteResult = {
      data: {
        connection: buildConnection({ state: "disconnected", account: null }),
        revocation: "unconfirmed",
        providerRemovalUrl: "https://www.notion.so/profile/integrations",
      },
      error: null,
    };
    const view = renderPanel(buildConnection());

    fireEvent.click(view.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(dialog(view).getByRole("button", { name: "Disconnect" }));

    expect(
      await dialog(view).findByText(/Scarn can't confirm it was revoked/),
    ).toBeTruthy();
    expect(dialog(view).queryByText(/accepted/)).toBeNull();
  });
});
