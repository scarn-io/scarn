import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type {
  ManagedConnectionContract,
  StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

type SavedStepBody = { opencodeMcpJson: unknown; healthChecksJson: unknown };

const putMock = mock((body: SavedStepBody) => {
  void body;
  return Promise.resolve({ data: null, error: null });
});

type ListResult = { data: unknown; error: unknown };

const connectionsApi = {
  result: Promise.resolve<ListResult>({ data: [], error: null }),
  calls: 0,
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": { put: putMock, post: putMock },
      projects: () => ({
        "mcp-connections": {
          get: () => {
            connectionsApi.calls += 1;
            return connectionsApi.result;
          },
        },
      }),
    },
  }),
}));

const { StepDefinitionDialog } = await import("./step-definition-dialog");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

function setupDom() {
  installDom({ url: "http://localhost/" });

  Object.assign(globalThis, {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb: FrameRequestCallback) =>
      setTimeout(() => {
        cb(Date.now());
      }, 0) as unknown as number,
    cancelAnimationFrame: (id: number) => {
      clearTimeout(id);
    },
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener() {},
        addListener() {},
        dispatchEvent() {
          return false;
        },
        matches: false,
        media: query,
        onchange: null,
        removeEventListener() {},
        removeListener() {},
      }) as MediaQueryList,
  });
}

function makeStep(
  overrides: Partial<StepDefinitionContract> = {},
): StepDefinitionContract {
  return {
    id: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe201"),
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    key: "browser-repro",
    name: "Browser Repro",
    description: null,
    prompt: "Open the app.",
    version: 1,
    kind: "user_defined",
    entrypointJson: null,
    toolCallJson: null,
    environment: null,
    inputSchemaJson: {},
    resultSchemaJson: {},
    errors: [],
    retry: [],
    grants: [],
    maxTurns: null,
    concurrency: null,
    logs: { archive: "always" },
    opencodeMcpJson: {
      postgres: { type: "ref", name: "postgres-readonly" },
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@0.0.68"],
        environment: {
          PLAYWRIGHT_BROWSERS_PATH: "{env:PLAYWRIGHT_BROWSERS_PATH}",
        },
      },
      linear: {
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer {env:LINEAR_API_KEY}" },
      },
    },
    healthChecksJson: [
      {
        kind: "tool",
        name: "postgres.listSchemas",
        tool: "list_schemas",
        mcp: "postgres",
        severity: "required",
        timeoutSeconds: 15,
        serialGroup: "postgres",
      },
      {
        kind: "tool",
        name: "playwright.navigate",
        tool: "browser_navigate",
        mcp: "playwright",
        args: { url: "about:blank" },
        severity: "required",
        timeoutSeconds: 15,
        serialGroup: "playwright",
      },
      {
        kind: "tool",
        name: "linear.whoami",
        tool: "whoami",
        mcp: "linear",
        severity: "warn",
        timeoutSeconds: 15,
        serialGroup: "linear",
      },
      {
        kind: "cli",
        name: "node",
        command: ["node", "--version"],
        expectExitCode: 0,
        severity: "required",
        timeoutSeconds: 15,
      },
    ],
    repo: {
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    },
    status: "active",
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  };
}

function renderDialog(step: StepDefinitionContract) {
  return render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={step.projectId}
      isMember
    >
      <StepDefinitionDialog
        open
        projectId={step.projectId}
        step={step}
        onSaved={() => {}}
        onClose={() => {}}
      />
    </ProjectRouteProvider>,
  );
}

const NOTION_ACCOUNT = {
  userName: "Ada Lovelace",
  workspaceName: "Analytical Engines",
  identityVerified: true,
};

function makeConnection(
  overrides: Partial<ManagedConnectionContract> = {},
): ManagedConnectionContract {
  return {
    id: parseUuidV7("0198f2c4-0000-7000-8000-000000000001"),
    projectId: parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe001"),
    name: "notion",
    label: "Notion",
    preset: "notion",
    resource: "https://mcp.notion.com/mcp",
    issuerOrigin: "https://mcp.notion.com",
    suppliedClient: null,
    scopes: null,
    state: "ready",
    reasonCode: null,
    generation: 1,
    version: 4,
    connectedBy: null,
    account: NOTION_ACCOUNT,
    grantedScopes: [],
    reconnectBy: null,
    candidate: null,
    lastRevocation: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function connectionStep(): StepDefinitionContract {
  return makeStep({
    opencodeMcpJson: {
      notion: {
        type: "remote",
        url: "https://mcp.notion.com/mcp",
        auth: { connection: "notion" },
      },
      notionRef: {
        type: "ref",
        name: "notion",
        auth: { connection: "notion" },
      },
    },
    healthChecksJson: [],
  });
}

function listReturns(result: ListResult) {
  connectionsApi.result = Promise.resolve(result);
}

function serverCard(view: ReturnType<typeof render>, key: string): string {
  const card = view.baseElement.querySelector(
    `[data-testid="mcp-server-${key}"]`,
  );
  if (!card) throw new Error(`Expected an MCP server card for ${key}`);
  return card.textContent;
}

async function saveEdit(step: StepDefinitionContract): Promise<SavedStepBody> {
  const view = renderDialog(step);
  const form = view.baseElement.querySelector("form");
  if (!form) throw new Error("Expected a form element");
  fireEvent.submit(form);
  await waitFor(() => {
    expect(putMock).toHaveBeenCalledTimes(1);
  });
  const call = putMock.mock.calls[0];
  if (!call) throw new Error("Expected the PUT to have been called");
  return call[0];
}

describe("StepDefinitionDialog MCP servers", () => {
  beforeEach(() => {
    setupDom();
    putMock.mockClear();
    connectionsApi.calls = 0;
    listReturns({ data: [], error: null });
  });

  afterEach(() => {
    cleanup();
  });

  test("lists servers read-only and points authors at defineMcp", () => {
    const view = renderDialog(makeStep());
    const text = view.baseElement.textContent;
    expect(text).toContain("MCP servers are defined in code with defineMcp.");
    expect(text).not.toContain("Add MCP Server");
  });

  test("shows a ref server's name and its checks", () => {
    const card = serverCard(renderDialog(makeStep()), "postgres");
    expect(card).toContain("ref");
    expect(card).toContain("postgres-readonly");
    expect(card).toContain("postgres.listSchemas → list_schemas");
    expect(card).toContain("required");
  });

  test("shows a local server's command and environment as written", () => {
    const card = serverCard(renderDialog(makeStep()), "playwright");
    expect(card).toContain("local");
    expect(card).toContain("npx -y @playwright/mcp@0.0.68");
    expect(card).toContain(
      "PLAYWRIGHT_BROWSERS_PATH: {env:PLAYWRIGHT_BROWSERS_PATH}",
    );
    expect(card).toContain("playwright.navigate → browser_navigate");
    expect(card).not.toContain("node --version");
  });

  test("shows a remote server's URL, headers and warn checks", () => {
    const card = serverCard(renderDialog(makeStep()), "linear");
    expect(card).toContain("remote");
    expect(card).toContain("https://mcp.linear.app/mcp");
    expect(card).toContain("Authorization: Bearer {env:LINEAR_API_KEY}");
    expect(card).toContain("linear.whoami → whoami");
    expect(card).toContain("warn");
  });

  test("saving an edit sends opencodeMcpJson and healthChecksJson exactly as loaded", async () => {
    const step = makeStep();
    const body = await saveEdit(step);
    expect(body.opencodeMcpJson).toEqual(step.opencodeMcpJson);
    expect(body.healthChecksJson).toEqual(step.healthChecksJson);
  });

  test("saving a step with no MCP servers keeps opencodeMcpJson null", async () => {
    const body = await saveEdit(makeStep({ opencodeMcpJson: null }));
    expect(body.opencodeMcpJson).toBeNull();
  });

  test("doesn't load connections when no server uses one", async () => {
    renderDialog(makeStep());
    await Promise.resolve();
    expect(connectionsApi.calls).toBe(0);
  });

  test("shows a connection-authenticated server's label, account and a settings link", async () => {
    listReturns({
      data: [makeConnection({ label: "Team Wiki" })],
      error: null,
    });
    const view = renderDialog(connectionStep());
    await waitFor(() => {
      expect(serverCard(view, "notion")).toContain(
        "Connected as Ada Lovelace in Analytical Engines",
      );
    });
    const card = serverCard(view, "notion");
    expect(card).toContain(
      "Authenticated by the project's Team Wiki connection",
    );
    expect(serverCard(view, "notionRef")).toContain(
      "Authenticated by the project's Team Wiki connection",
    );
    const link = view.baseElement.querySelector(
      '[data-testid="mcp-server-notion"] a',
    );
    expect(link?.getAttribute("href")).toBe("/tester/demo/settings");
    expect(connectionsApi.calls).toBe(1);
  });

  test("says not connected when the project has no connection, naming it by its connection name", async () => {
    const view = renderDialog(connectionStep());
    await waitFor(() => {
      expect(serverCard(view, "notion")).toContain("Not connected");
    });
    expect(serverCard(view, "notion")).toContain(
      "Authenticated by the project's notion connection",
    );
  });

  test("says reconnect required when the connection needs it", async () => {
    listReturns({
      data: [makeConnection({ state: "reconnect_required" })],
      error: null,
    });
    const view = renderDialog(connectionStep());
    await waitFor(() => {
      expect(serverCard(view, "notion")).toContain("Reconnect required");
    });
    expect(serverCard(view, "notion")).not.toContain("Connected as");
  });

  test("notes a pending reconnect alongside the serving account", async () => {
    listReturns({
      data: [makeConnection({ state: "ready_with_pending_reconnect" })],
      error: null,
    });
    const view = renderDialog(connectionStep());
    await waitFor(() => {
      expect(serverCard(view, "notion")).toContain(
        "A reconnect is waiting for confirmation",
      );
    });
    expect(serverCard(view, "notion")).toContain(
      "Connected as Ada Lovelace in Analytical Engines",
    );
  });

  test("shows a neutral message when the status can't be loaded", async () => {
    listReturns({
      data: null,
      error: { status: 403, value: { status: 403, code: "forbidden" } },
    });
    const view = renderDialog(connectionStep());
    await waitFor(() => {
      expect(serverCard(view, "notion")).toContain(
        "Couldn't load the connection's status",
      );
    });
  });

  test("hides a connection-authenticated server's headers", () => {
    const step = makeStep({
      opencodeMcpJson: {
        notion: {
          type: "remote",
          url: "https://mcp.notion.com/mcp",
          headers: { "X-Trace": "1" },
          auth: { connection: "notion" },
        },
      },
      healthChecksJson: [],
    });
    const card = serverCard(renderDialog(step), "notion");
    expect(card).not.toContain("Headers");
    expect(card).not.toContain("X-Trace");
  });

  test("saving keeps each server's auth unchanged, even when the status fails to load", async () => {
    connectionsApi.result = Promise.reject(new Error("network down"));
    const step = connectionStep();
    const body = await saveEdit(step);
    expect(body.opencodeMcpJson).toEqual(step.opencodeMcpJson);
  });
});
