import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { ManagedConnectionContract } from "@scarn/api/frontend-contracts";
import {
  ACME_CONNECTION_ID,
  ACME_PRESET,
  CONNECTION_ID,
  NOTION_PRESET,
  apiState,
  buildAcmeConnection,
  buildConnection,
  cleanup,
  dialog,
  disclosureFor,
  fireEvent,
  redirects,
  renderPanel,
  resetHarness,
  waitFor,
  within,
} from "./project-mcp-connections-panel-test-support";

setDefaultTimeout(15_000);

const disconnected: Partial<ManagedConnectionContract> = {
  state: "disconnected",
  connectedBy: null,
  account: null,
  grantedScopes: [],
  reconnectBy: null,
};

const card = (view: ReturnType<typeof renderPanel>, label: string) =>
  within(view.getByRole("region", { name: `${label} connection` }));

/** Several connections in one project: one card each, each acting on its own. */
describe("ProjectMcpConnectionsPanel with several connections", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows one card per connection, each with its own label and account", () => {
    const view = renderPanel([buildConnection(), buildAcmeConnection()]);

    expect(
      card(view, "Notion").getByText(
        "Connected as Ada Lovelace in Analytical Engines",
      ),
    ).toBeTruthy();
    expect(
      card(view, "Acme docs").getByText("Connected as Grace"),
    ).toBeTruthy();
    expect(
      card(view, "Acme docs").getByText(
        "Acme docs didn't fully identify this account.",
      ),
    ).toBeTruthy();
  });

  test("the add menu lists only presets with no connection yet", () => {
    const view = renderPanel(buildConnection());

    fireEvent.click(view.getByRole("button", { name: "Add connection" }));

    expect(view.getByRole("menuitem", { name: "Acme docs" })).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: "Notion" })).toBeNull();
  });

  test("a disconnected connection keeps its card and stays out of the add menu", () => {
    const view = renderPanel([
      buildConnection(disconnected),
      buildAcmeConnection(),
    ]);

    expect(
      card(view, "Notion").getByRole("button", { name: "Connect Notion" }),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add connection" })).toBeNull();
  });

  test("a connection with another name on a preset's MCP URL hides that preset", () => {
    const view = renderPanel(
      buildAcmeConnection({ name: "docs", preset: null }),
    );

    fireEvent.click(view.getByRole("button", { name: "Add connection" }));

    expect(view.getByRole("menuitem", { name: "Notion" })).toBeTruthy();
    expect(view.queryByRole("menuitem", { name: "Acme docs" })).toBeNull();
  });

  test("adding a preset starts it by key with its own disclosure", async () => {
    apiState.startResult = {
      data: {
        connectionId: ACME_CONNECTION_ID,
        authorizationUrl: "https://mcp.acme.example/authorize?x=1",
      },
      error: null,
    };
    const view = renderPanel(buildConnection());

    fireEvent.click(view.getByRole("button", { name: "Add connection" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Acme docs" }));
    expect(dialog(view).getByText(disclosureFor("Acme docs"))).toBeTruthy();
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Continue to Acme docs" }),
    );

    await waitFor(() => {
      expect(redirects).toEqual(["https://mcp.acme.example/authorize?x=1"]);
    });
    expect(apiState.calls).toEqual([
      { route: "start", body: { preset: "acme-docs" } },
    ]);
  });

  test("connecting a disconnected card starts only that connection", async () => {
    apiState.startResult = {
      data: {
        connectionId: ACME_CONNECTION_ID,
        authorizationUrl: "https://mcp.acme.example/authorize?y=1",
      },
      error: null,
    };
    const view = renderPanel([
      buildConnection(),
      buildAcmeConnection(disconnected),
    ]);

    fireEvent.click(
      card(view, "Acme docs").getByRole("button", {
        name: "Connect Acme docs",
      }),
    );
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Continue to Acme docs" }),
    );

    await waitFor(() => {
      expect(redirects).toEqual(["https://mcp.acme.example/authorize?y=1"]);
    });
    expect(apiState.calls).toEqual([
      { route: "start", body: { preset: "acme-docs", name: "acme-docs" } },
    ]);
    const notion = within(
      view.getByRole("region", { name: "Notion connection", hidden: true }),
    );
    expect(notion.getByText("Connected")).toBeTruthy();
  });

  test("disconnecting one connection leaves the other connected", async () => {
    apiState.deleteResult = {
      data: {
        connection: buildAcmeConnection({
          ...disconnected,
          lastRevocation: {
            outcome: "accepted",
            at: "2026-11-17T12:00:00.000Z",
          },
        }),
        revocation: "accepted",
        providerRemovalUrl: null,
      },
      error: null,
    };
    const view = renderPanel([buildConnection(), buildAcmeConnection()]);

    fireEvent.click(
      card(view, "Acme docs").getByRole("button", { name: "Disconnect" }),
    );
    expect(dialog(view).getByText("Disconnect Acme docs?")).toBeTruthy();
    fireEvent.click(dialog(view).getByRole("button", { name: "Disconnect" }));

    expect(
      await dialog(view).findByText(
        "Acme docs accepted Scarn's request to revoke this connection's access.",
      ),
    ).toBeTruthy();
    expect(dialog(view).queryByRole("link")).toBeNull();
    fireEvent.click(dialog(view).getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(view.queryByRole("dialog")).toBeNull();
    });
    expect(card(view, "Acme docs").getByText("Not connected")).toBeTruthy();
    expect(card(view, "Acme docs").queryByRole("link")).toBeNull();
    expect(
      card(view, "Notion").getByText(
        "Connected as Ada Lovelace in Analytical Engines",
      ),
    ).toBeTruthy();
    expect(apiState.calls).toEqual([
      { route: "delete", connectionId: ACME_CONNECTION_ID },
    ]);
  });

  test("reconnecting one card reconnects only that connection", async () => {
    apiState.reconnectResult = {
      data: {
        connectionId: CONNECTION_ID,
        authorizationUrl: "https://mcp.notion.com/authorize?r=2",
      },
      error: null,
    };
    const view = renderPanel([buildConnection(), buildAcmeConnection()]);

    fireEvent.click(
      card(view, "Notion").getByRole("button", { name: "Reconnect" }),
    );
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Continue to Notion" }),
    );

    await waitFor(() => {
      expect(redirects).toEqual(["https://mcp.notion.com/authorize?r=2"]);
    });
    expect(apiState.calls).toEqual([
      { route: "reconnect", connectionId: CONNECTION_ID },
    ]);
  });

  test("the revocation history links to the preset's removal page only when it has one", () => {
    const revoked = {
      ...disconnected,
      lastRevocation: {
        outcome: "accepted" as const,
        at: "2026-11-17T12:00:00.000Z",
      },
    };
    const view = renderPanel(
      [buildConnection(revoked), buildAcmeConnection(revoked)],
      { presets: [NOTION_PRESET, ACME_PRESET] },
    );

    expect(
      card(view, "Notion")
        .getByRole("link", { name: "Notion's connections settings" })
        .getAttribute("href"),
    ).toBe("https://www.notion.so/profile/integrations");
    expect(
      card(view, "Acme docs").getByText(/Last revocation attempt/),
    ).toBeTruthy();
    expect(card(view, "Acme docs").queryByRole("link")).toBeNull();
  });

  test("a connection without a preset can't be connected again from its card", () => {
    const view = renderPanel(
      buildAcmeConnection({ ...disconnected, name: "docs", preset: null }),
    );

    expect(
      card(view, "Acme docs").queryByRole("button", {
        name: "Connect Acme docs",
      }),
    ).toBeNull();
  });
});
