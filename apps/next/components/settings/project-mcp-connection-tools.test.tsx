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
  fireEvent,
  problem,
  renderPanel,
  resetHarness,
  waitFor,
} from "./project-mcp-connections-panel-test-support";

setDefaultTimeout(15_000);

const RUNNER = ["secrets:read", "secrets:write", "executions:write"];

const TOOLS = {
  data: {
    tools: [
      {
        name: "notion-search",
        description: "Search the workspace.",
        inputSchema: { type: "object" },
        readOnlyHint: true,
      },
      {
        name: "notion-create-pages",
        description: "Create pages.",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { pageIds: { type: "array" } },
        },
      },
    ],
    listedAt: "2026-11-18T00:00:00.000Z",
    cached: false,
  },
  error: null,
};

const toolCalls = () =>
  apiState.calls.filter((call) => call.route === "tools").length;

describe("ProjectMcpConnectionTools", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows the tool count, expandable to names, descriptions, read-only and structured-output badges", async () => {
    apiState.toolsResults = [TOOLS];
    const view = renderPanel(buildConnection(), { permissions: RUNNER });

    await waitFor(() => {
      expect(view.getByText("Working — 2 tools available")).toBeTruthy();
    });
    expect(view.queryByText("notion-search")).toBeNull();
    expect(apiState.calls).toContainEqual({
      route: "tools",
      connectionId: CONNECTION_ID,
    });

    fireEvent.click(view.getByRole("button", { name: "Show tools" }));

    expect(view.getByText("notion-search")).toBeTruthy();
    expect(view.getByText("Search the workspace.")).toBeTruthy();
    expect(view.getByText("notion-create-pages")).toBeTruthy();
    expect(view.getAllByText("Read-only")).toHaveLength(1);
    expect(view.getAllByText("Structured output")).toHaveLength(1);
  });

  test("members without executions:write see the card without the tool list", () => {
    apiState.toolsResults = [TOOLS];
    const view = renderPanel(buildConnection(), {
      permissions: ["secrets:read", "secrets:write"],
    });

    expect(
      view.getByText("Connected as Ada Lovelace in Analytical Engines"),
    ).toBeTruthy();
    expect(view.queryByText(/tools available/)).toBeNull();
    expect(toolCalls()).toBe(0);
  });

  test("doesn't list tools when reconnect is required", () => {
    apiState.toolsResults = [TOOLS];
    const view = renderPanel(
      buildConnection({
        state: "reconnect_required",
        reasonCode: "refresh_failed",
      }),
      { permissions: RUNNER },
    );

    expect(
      view.getByText(
        "Notion stopped accepting this connection. Reconnect to keep using it.",
      ),
    ).toBeTruthy();
    expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(toolCalls()).toBe(0);
  });

  test("an unreachable provider shows our message and retries on request", async () => {
    apiState.toolsResults = [
      {
        data: null,
        error: problem(
          502,
          "MANAGED_CONNECTION_PROVIDER_UNAVAILABLE",
          "upstream said <html>secret</html>",
        ),
      },
      TOOLS,
    ];
    const view = renderPanel(buildConnection(), { permissions: RUNNER });

    await waitFor(() => {
      expect(
        view.getByText("Couldn't reach Notion to list tools. Try again."),
      ).toBeTruthy();
    });
    expect(view.queryByText(/secret/)).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(view.getByText("Working — 2 tools available")).toBeTruthy();
    });
    expect(toolCalls()).toBe(2);
  });

  test("a busy refresh is retried once after Retry-After", async () => {
    const busy = {
      data: null,
      error: problem(503, "MANAGED_CONNECTION_REFRESH_BUSY", "busy"),
      response: new Response(null, {
        status: 503,
        headers: { "Retry-After": "0" },
      }),
    };
    apiState.toolsResults = [busy, TOOLS];
    const view = renderPanel(buildConnection(), { permissions: RUNNER });

    await waitFor(() => {
      expect(view.getByText("Working — 2 tools available")).toBeTruthy();
    });
    expect(toolCalls()).toBe(2);
  });

  test("still busy after one retry shows the retry message", async () => {
    apiState.toolsResults = [
      {
        data: null,
        error: problem(503, "MANAGED_CONNECTION_REFRESH_BUSY", "busy"),
        response: new Response(null, {
          status: 503,
          headers: { "Retry-After": "0" },
        }),
      },
    ];
    const view = renderPanel(buildConnection(), { permissions: RUNNER });

    await waitFor(() => {
      expect(
        view.getByText("Couldn't reach Notion to list tools. Try again."),
      ).toBeTruthy();
    });
    expect(toolCalls()).toBe(2);
  });

  test("a not-ready connection reloads and shows the reconnect UI", async () => {
    apiState.toolsResults = [
      {
        data: null,
        error: problem(409, "MANAGED_CONNECTION_NOT_READY", "not ready"),
      },
    ];
    apiState.listResult = {
      data: [
        buildConnection({
          state: "reconnect_required",
          reasonCode: "refresh_failed",
        }),
      ],
      error: null,
    };
    const view = renderPanel(buildConnection(), { permissions: RUNNER });

    await waitFor(() => {
      expect(view.getByText("Reconnect required")).toBeTruthy();
    });
    expect(apiState.calls).toContainEqual({ route: "list" });
    expect(view.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(view.queryByText(/list tools/)).toBeNull();
  });
});
