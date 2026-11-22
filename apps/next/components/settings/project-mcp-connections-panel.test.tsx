import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  CANDIDATE_ID,
  CONNECTION_ID,
  DISCLOSURE,
  apiState,
  awaitingFirstConfirmation,
  buildCandidate,
  buildConnection,
  cleanup,
  dialog,
  fireEvent,
  problem,
  redirects,
  renderPanel,
  replaces,
  resetHarness,
  waitFor,
  within,
} from "./project-mcp-connections-panel-test-support";

setDefaultTimeout(15_000);

describe("ProjectMcpConnectionsPanel", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the connected account, scopes, connector and reconnect date", () => {
    const view = renderPanel(buildConnection());

    const card = within(
      view.getByRole("region", { name: "Notion connection" }),
    );
    expect(card.getByText("Connected")).toBeTruthy();
    expect(
      card.getByText("Connected as Ada Lovelace in Analytical Engines"),
    ).toBeTruthy();
    expect(card.getByText("read")).toBeTruthy();
    expect(card.getByText("write")).toBeTruthy();
    expect(card.getByText("Connected by ada")).toBeTruthy();
    expect(card.getByText(/^Reconnect by /)).toBeTruthy();
  });

  test.each([
    ["accepted", /Notion accepted Scarn's request to revoke/],
    ["failed", /Notion refused.*Scarn can't confirm it was revoked/],
    ["unconfirmed", /Notion didn't answer.*Scarn can't confirm it was revoked/],
  ] as const)(
    "shows a persisted %s revocation on the disconnected card for read-only members",
    (outcome, message) => {
      const at = "2026-11-17T12:00:00.000Z";
      const view = renderPanel(
        buildConnection({
          state: "disconnected",
          account: null,
          connectedBy: null,
          grantedScopes: [],
          reconnectBy: null,
          lastRevocation: { outcome, at },
        }),
        { permissions: ["secrets:read"] },
      );
      const card = within(
        view.getByRole("region", { name: "Notion connection" }),
      );

      expect(card.getByText(message)).toBeTruthy();
      const date = card
        .getByText(/Last revocation attempt/)
        .querySelector("time");
      expect(date?.getAttribute("datetime")).toBe(at);
      expect(date?.textContent).toContain("2026");
      const link = card.getByRole("link", {
        name: "Notion's connections settings",
      });
      expect(link.getAttribute("href")).toBe(
        "https://www.notion.so/profile/integrations",
      );
    },
  );

  test.each(["disconnected", "connecting", "ready"] as const)(
    "does not show revocation history when it is null in %s state",
    (state) => {
      const view = renderPanel(
        buildConnection({ state, lastRevocation: null }),
      );

      expect(view.queryByText(/Last revocation attempt/)).toBeNull();
      expect(
        view.queryByRole("link", { name: "Notion's connections settings" }),
      ).toBeNull();
    },
  );

  test("adding a preset shows the disclosure, then leaves for the authorization URL", async () => {
    apiState.startResult = {
      data: {
        connectionId: CONNECTION_ID,
        authorizationUrl: "https://mcp.notion.com/authorize?x=1",
      },
      error: null,
    };
    const view = renderPanel(null);

    expect(view.getByText("This project has no connections yet.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Add connection" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Notion" }));
    expect(dialog(view).getByText(DISCLOSURE)).toBeTruthy();
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Continue to Notion" }),
    );

    await waitFor(() => {
      expect(redirects).toEqual(["https://mcp.notion.com/authorize?x=1"]);
    });
    expect(apiState.calls).toEqual([
      { route: "start", body: { preset: "notion" } },
    ]);
  });

  test("a failed connect keeps the dialog open with the API message", async () => {
    apiState.startResult = {
      data: null,
      error: problem(
        409,
        "MANAGED_CONNECTION_STATE_CONFLICT",
        "This project is already connected.",
      ),
    };
    const view = renderPanel(null);

    fireEvent.click(view.getByRole("button", { name: "Add connection" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Notion" }));
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Continue to Notion" }),
    );

    expect(
      await dialog(view).findByText("This project is already connected."),
    ).toBeTruthy();
    expect(redirects).toEqual([]);
  });

  test("reconnects from ready", async () => {
    apiState.reconnectResult = {
      data: {
        connectionId: CONNECTION_ID,
        authorizationUrl: "https://mcp.notion.com/authorize?r=1",
      },
      error: null,
    };
    const view = renderPanel(buildConnection());

    fireEvent.click(view.getByRole("button", { name: "Reconnect" }));
    expect(dialog(view).getByText(DISCLOSURE)).toBeTruthy();
    expect(
      dialog(view).getByText(/current connection keeps working/),
    ).toBeTruthy();
    fireEvent.click(
      dialog(view).getByRole("button", { name: "Continue to Notion" }),
    );

    await waitFor(() => {
      expect(redirects).toEqual(["https://mcp.notion.com/authorize?r=1"]);
    });
    expect(apiState.calls).toEqual([
      { route: "reconnect", connectionId: CONNECTION_ID },
    ]);
  });

  test("offers reconnect when reconnect is required, with the reason", () => {
    const view = renderPanel(
      buildConnection({
        state: "reconnect_required",
        reasonCode: "refresh_failed",
      }),
    );

    expect(view.getByText("Reconnect required")).toBeTruthy();
    expect(
      view.getByText(
        "Notion stopped accepting this connection. Reconnect to keep using it.",
      ),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  test("confirms a first connection with the disclosure and clears the URL", async () => {
    apiState.confirmResult = { data: buildConnection(), error: null };
    const view = renderPanel(awaitingFirstConfirmation());

    const card = within(
      view.getByRole("region", { name: "Confirm Notion connection" }),
    );
    expect(card.getByText(DISCLOSURE)).toBeTruthy();
    expect(
      card.getByText("Connected as Ada Lovelace in Analytical Engines"),
    ).toBeTruthy();
    expect(card.getByText("read")).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: "Confirm" }));

    expect(await view.findByText(/Notion connected\./)).toBeTruthy();
    expect(apiState.calls).toEqual([
      {
        route: "confirm",
        connectionId: CONNECTION_ID,
        body: {
          candidateId: CANDIDATE_ID,
          fingerprint: "fp-123",
          expectedVersion: 4,
        },
      },
    ]);
    expect(
      view.queryByRole("region", { name: "Confirm Notion connection" }),
    ).toBeNull();
    expect(replaces).toEqual(["/tester/demo/settings"]);
  });

  test("cancels a candidate", async () => {
    apiState.cancelResult = {
      data: buildConnection({
        state: "disconnected",
        reasonCode: "candidate_cancelled",
        connectedBy: null,
        account: null,
        grantedScopes: [],
        reconnectBy: null,
      }),
      error: null,
    };
    const view = renderPanel(awaitingFirstConfirmation());

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));

    expect(
      await view.findByText("Cancelled. Nothing was connected."),
    ).toBeTruthy();
    expect(apiState.calls).toEqual([
      {
        route: "cancel",
        connectionId: CONNECTION_ID,
        body: { candidateId: CANDIDATE_ID },
      },
    ]);
    expect(replaces).toEqual(["/tester/demo/settings"]);
  });

  test("a reconnect candidate shows what changed and that identity is unverified", () => {
    const view = renderPanel(
      buildConnection({
        state: "ready_with_pending_reconnect",
        candidate: buildCandidate({
          account: {
            userName: "Ada Lovelace",
            workspaceName: "Difference Engines",
            identityVerified: false,
          },
          grantedScopes: ["read", "comment"],
          sameIdentityAsActive: "unknown",
        }),
      }),
    );

    const card = within(
      view.getByRole("region", { name: "Confirm Notion connection" }),
    );
    expect(
      card.getByText(/can.t verify this is the same account/),
    ).toBeTruthy();
    expect(
      card.getByText("Was: Connected as Ada Lovelace in Analytical Engines"),
    ).toBeTruthy();
    expect(card.getByText("Adds permissions: comment")).toBeTruthy();
    expect(card.getByText("Removes permissions: write")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  test("a reconnect candidate for a different account says so", () => {
    const view = renderPanel(
      buildConnection({
        state: "ready_with_pending_reconnect",
        candidate: buildCandidate({ sameIdentityAsActive: false }),
      }),
    );

    expect(
      view.getByText(
        "This is a different Notion account from the current connection.",
      ),
    ).toBeTruthy();
  });

  test("an expired candidate shows the API message and reloads", async () => {
    apiState.confirmResult = {
      data: null,
      error: problem(
        409,
        "MANAGED_CANDIDATE_EXPIRED",
        "This connection request has expired. Connect again.",
      ),
    };
    apiState.listResult = {
      data: [
        buildConnection({
          state: "disconnected",
          reasonCode: "candidate_expired",
          connectedBy: null,
          account: null,
          grantedScopes: [],
          reconnectBy: null,
        }),
      ],
      error: null,
    };
    const view = renderPanel(awaitingFirstConfirmation());

    fireEvent.click(view.getByRole("button", { name: "Confirm" }));

    expect(
      await view.findByText(/wasn't confirmed within 10 minutes/),
    ).toBeTruthy();
    expect(apiState.calls.map((call) => call.route)).toEqual([
      "confirm",
      "list",
    ]);
    expect(view.getByRole("button", { name: "Connect Notion" })).toBeTruthy();
  });

  test("maps a callback error code to a safe message", () => {
    const view = renderPanel(null, { callbackError: "access_denied" });

    expect(
      view.getByText("Access wasn't granted, so nothing was connected."),
    ).toBeTruthy();
  });

  test("is read-only without secrets:write", () => {
    const view = renderPanel(
      buildConnection({
        state: "ready_with_pending_reconnect",
        candidate: buildCandidate(),
      }),
      { permissions: ["secrets:read"] },
    );

    expect(view.getByText(/Only project admins can add/)).toBeTruthy();
    expect(
      view.getByText("Connected as Ada Lovelace in Analytical Engines"),
    ).toBeTruthy();
    expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(
      view.queryByRole("region", { name: "Confirm Notion connection" }),
    ).toBeNull();
  });
});
