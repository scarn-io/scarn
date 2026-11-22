import { mock } from "bun:test";
import { JSDOM } from "jsdom";
import type {
  ManagedConnectionCandidateContract,
  ManagedConnectionContract,
  ManagedConnectionPresetContract,
} from "@scarn/api/frontend-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";

/**
 * Shared harness for the `ProjectMcpConnectionsPanel` tests. DOM globals go
 * in before React DOM loads (hence the dynamic imports below). The browser
 * API client, `next/navigation` and the full-page redirect are replaced by
 * stubs that record what the panel did.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/tester/demo/settings?connection=x",
});

Object.assign(globalThis, {
  document: dom.window.document,
  DocumentFragment: dom.window.DocumentFragment,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  MutationObserver: dom.window.MutationObserver,
  Node: dom.window.Node,
  ShadowRoot: dom.window.ShadowRoot,
  SVGElement: dom.window.SVGElement,
  navigator: dom.window.navigator,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});

type ApiResult = { data: unknown; error: unknown; response?: Response };
type CandidateBody = {
  candidateId: string;
  fingerprint?: string;
  expectedVersion?: number;
};

export const PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe000";
export const CONNECTION_ID = "0198f2c4-0000-7000-8000-000000000001";
export const CANDIDATE_ID = "0198f2c4-0000-7000-8000-000000000002";
export const ACME_CONNECTION_ID = "0198f2c4-0000-7000-8000-000000000004";
const USER_ID = "0198f2c4-0000-7000-8000-0000000000aa";

export const apiState = {
  listResult: { data: [], error: null } as ApiResult,
  stepDefinitionsResult: { data: [], error: null } as ApiResult,
  startResult: { data: null, error: null } as ApiResult,
  reconnectResult: { data: null, error: null } as ApiResult,
  confirmResult: { data: null, error: null } as ApiResult,
  cancelResult: { data: null, error: null } as ApiResult,
  deleteResult: { data: null, error: null } as ApiResult,
  usageResult: Promise.resolve({
    data: { steps: [], liveRuns: 0 },
    error: null,
  }) as Promise<ApiResult>,
  usageCalls: [] as string[],
  /** Served in order; the last one repeats. */
  toolsResults: [] as ApiResult[],
  calls: [] as {
    route: string;
    connectionId?: string;
    body?: CandidateBody | { preset: string; name?: string };
  }[],
};

export const redirects: string[] = [];
export const replaces: string[] = [];
export const navigationState = { search: "" };

export const resetHarness = () => {
  apiState.listResult = { data: [], error: null };
  apiState.stepDefinitionsResult = { data: [], error: null };
  navigationState.search = "";
  apiState.startResult = { data: null, error: null };
  apiState.reconnectResult = { data: null, error: null };
  apiState.confirmResult = { data: null, error: null };
  apiState.cancelResult = { data: null, error: null };
  apiState.deleteResult = { data: null, error: null };
  apiState.toolsResults = [];
  apiState.usageResult = Promise.resolve({
    data: { steps: [], liveRuns: 0 },
    error: null,
  });
  apiState.usageCalls.length = 0;
  apiState.calls.length = 0;
  redirects.length = 0;
  replaces.length = 0;
};

void mock.module("@/app/_lib/scarn-browser-api-client", () => ({
  getBrowserScarnApiClient: () => ({
    api: {
      "step-definitions": {
        get: () => Promise.resolve(apiState.stepDefinitionsResult),
      },
      projects: () => ({
        "mcp-connections": Object.assign(
          ({ connectionId }: { connectionId: string }) => ({
            usage: {
              get: () => {
                apiState.usageCalls.push(connectionId);
                return apiState.usageResult;
              },
            },
            reconnect: {
              post: () => {
                apiState.calls.push({ route: "reconnect", connectionId });
                return Promise.resolve(apiState.reconnectResult);
              },
            },
            candidate: {
              confirm: {
                post: (body: CandidateBody) => {
                  apiState.calls.push({ route: "confirm", connectionId, body });
                  return Promise.resolve(apiState.confirmResult);
                },
              },
              cancel: {
                post: (body: CandidateBody) => {
                  apiState.calls.push({ route: "cancel", connectionId, body });
                  return Promise.resolve(apiState.cancelResult);
                },
              },
            },
            delete: () => {
              apiState.calls.push({ route: "delete", connectionId });
              return Promise.resolve(apiState.deleteResult);
            },
            tools: {
              get: () => {
                apiState.calls.push({ route: "tools", connectionId });
                const results = apiState.toolsResults;
                return Promise.resolve(
                  results.length > 1
                    ? results.shift()
                    : (results[0] ?? { data: null, error: null }),
                );
              },
            },
          }),
          {
            get: () => {
              apiState.calls.push({ route: "list" });
              return Promise.resolve(apiState.listResult);
            },
            post: (body: { preset: string; name?: string }) => {
              apiState.calls.push({ route: "start", body });
              return Promise.resolve(apiState.startResult);
            },
          },
        ),
      }),
    },
  }),
}));

void mock.module("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigationState.search),
  useRouter: () => ({
    replace: (href: string) => {
      replaces.push(href);
    },
  }),
  usePathname: () => "/tester/demo/settings",
}));

void mock.module("./full-page-redirect", () => ({
  redirectToUrl: (url: string) => {
    redirects.push(url);
  },
}));

export const { cleanup, fireEvent, render, waitFor, within } =
  await import("@testing-library/react");
const { ProjectMcpConnectionsPanel } =
  await import("./project-mcp-connections-panel");
const { ProjectRouteProvider } =
  await import("@/components/project-route-context");

const ACCOUNT = {
  userName: "Ada Lovelace",
  workspaceName: "Analytical Engines",
  identityVerified: true,
};

export const buildCandidate = (
  overrides: Partial<ManagedConnectionCandidateContract> = {},
): ManagedConnectionCandidateContract => ({
  id: parseUuidV7(CANDIDATE_ID),
  account: ACCOUNT,
  grantedScopes: ["read", "write"],
  missingScopes: [],
  fingerprint: "fp-123",
  expiresAt: "2026-11-17T12:10:00.000Z",
  sameIdentityAsActive: "unknown",
  ...overrides,
});

export const buildConnection = (
  overrides: Partial<ManagedConnectionContract> = {},
): ManagedConnectionContract => ({
  id: parseUuidV7(CONNECTION_ID),
  projectId: parseUuidV7(PROJECT_ID),
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
  connectedBy: { userId: parseUuidV7(USER_ID), username: "ada" },
  account: ACCOUNT,
  grantedScopes: ["read", "write"],
  reconnectBy: "2027-02-15T00:00:00.000Z",
  candidate: null,
  lastRevocation: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

/** A second, non-Notion connection, created from the "acme-docs" preset. */
export const buildAcmeConnection = (
  overrides: Partial<ManagedConnectionContract> = {},
): ManagedConnectionContract =>
  buildConnection({
    id: parseUuidV7(ACME_CONNECTION_ID),
    name: "acme-docs",
    label: "Acme docs",
    preset: "acme-docs",
    resource: "https://mcp.acme.example/mcp",
    account: {
      userName: "Grace",
      workspaceName: null,
      identityVerified: false,
    },
    ...overrides,
  });

export const NOTION_PRESET: ManagedConnectionPresetContract = {
  key: "notion",
  label: "Notion",
  resource: "https://mcp.notion.com/mcp",
  removalUrl: "https://www.notion.so/profile/integrations",
};

export const ACME_PRESET: ManagedConnectionPresetContract = {
  key: "acme-docs",
  label: "Acme docs",
  resource: "https://mcp.acme.example/mcp",
  removalUrl: null,
};

export const awaitingFirstConfirmation = () =>
  buildConnection({
    state: "awaiting_confirmation",
    connectedBy: null,
    account: null,
    grantedScopes: [],
    reconnectBy: null,
    candidate: buildCandidate(),
  });

export const problem = (status: number, code: string, detail: string) => ({
  status,
  value: { status, code, detail },
});

const ADMIN = ["secrets:read", "secrets:write"];

/** Renders the panel with no, one or several connections and the given preset catalog. */
export const renderPanel = (
  connections: ManagedConnectionContract | ManagedConnectionContract[] | null,
  {
    permissions = ADMIN,
    callbackError = null,
    presets = [NOTION_PRESET, ACME_PRESET],
  }: {
    permissions?: string[];
    presets?: ManagedConnectionPresetContract[];
    callbackError?: Parameters<
      typeof ProjectMcpConnectionsPanel
    >[0]["callbackError"];
  } = {},
) =>
  render(
    <ProjectRouteProvider
      username="tester"
      projectSlug="demo"
      projectId={PROJECT_ID}
      isMember
      permissions={permissions}
    >
      <ProjectMcpConnectionsPanel
        projectId={PROJECT_ID}
        initialConnections={
          connections === null
            ? []
            : Array.isArray(connections)
              ? connections
              : [connections]
        }
        presets={presets}
        callbackError={callbackError}
      />
    </ProjectRouteProvider>,
  );

export const dialog = (view: ReturnType<typeof render>) =>
  within(view.getByRole("dialog"));

export const disclosureFor = (label: string) =>
  `Anyone who can run steps in this project will be able to act in ${label} as this account.`;

export const DISCLOSURE = disclosureFor("Notion");
