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
  buildConnection,
  cleanup,
  renderPanel,
  resetHarness,
  within,
} from "./project-mcp-connections-panel-test-support";

setDefaultTimeout(15_000);

const custom = (
  overrides: Partial<ManagedConnectionContract> = {},
): ManagedConnectionContract =>
  buildConnection({
    name: "slack",
    label: "Slack",
    preset: null,
    resource: "https://mcp.slack.com/mcp",
    issuerOrigin: "https://slack.com",
    ...overrides,
  });

const card = (view: ReturnType<typeof renderPanel>) =>
  within(view.getByRole("region", { name: "Slack connection" }));

/** Connections to custom servers, made from the CLI (decision 12 and 13). */
describe("ProjectMcpConnectionsPanel with a custom connection", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows its label, its authorization server and that it came from the CLI", () => {
    const view = renderPanel(custom());

    expect(
      card(view).getByText(
        "Connected from the CLI · Signs in with https://slack.com",
      ),
    ).toBeTruthy();
    expect(card(view).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(card(view).queryByText(/Reconnect from the CLI/)).toBeNull();
  });

  test("a supplied client has no browser reconnect and names the CLI command", () => {
    const view = renderPanel(
      custom({
        suppliedClient: {
          clientId: "1601185624273.8899143856786",
          redirectUri: "http://localhost:3118/callback",
        },
        state: "reconnect_required",
      }),
    );

    expect(card(view).queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(card(view).getByText(/Reconnect from the CLI:/)).toBeTruthy();
    expect(
      card(view).getByText("scarn connections reconnect slack"),
    ).toBeTruthy();
    expect(card(view).getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  test("a preset connection shows no CLI details", () => {
    const view = renderPanel(buildConnection());

    expect(view.queryByText(/Connected from the CLI/)).toBeNull();
  });
});
