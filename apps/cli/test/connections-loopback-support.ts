import type {
  ConnectionsApi,
  ManagedConnection,
} from "../src/lib/connections-api";
import type { LoopbackSignInPorts } from "../src/lib/connections-loopback";
import { bindLoopbackCallback } from "../src/lib/loopback-callback";

/**
 * Fakes for the loopback sign-in tests: an API that records what reaches it,
 * and a browser that "signs in" by GETting the redirect on the real listener.
 */

/** Awaits a rejection and returns the error. */
export async function rejectionOf(
  promise: Promise<object | null>,
): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected an Error, received ${String(error)}`);
  }
  throw new Error("Expected a rejection, but it resolved.");
}

export const PROJECT_ID = "project-1";
export const PROJECT_REF = "acme/web";
export const SECRET = "completion-secret-value";
export const CODE = "authorization-code-value";

export const candidateConnection = (
  overrides: Partial<ManagedConnection> = {},
): ManagedConnection => ({
  id: "conn-1",
  projectId: PROJECT_ID,
  name: "notion",
  label: "Notion",
  preset: "notion",
  resource: "https://mcp.notion.test/mcp",
  issuerOrigin: "https://mcp.notion.test",
  suppliedClient: null,
  scopes: null,
  state: "awaiting_confirmation",
  reasonCode: null,
  generation: 1,
  version: 3,
  connectedBy: null,
  account: null,
  grantedScopes: [],
  reconnectBy: null,
  candidate: {
    id: "cand-1",
    account: {
      userName: "Ada",
      workspaceName: "Acme",
      identityVerified: true,
    },
    grantedScopes: ["read"],
    missingScopes: [],
    fingerprint: "fp-1",
    expiresAt: "2026-11-20T00:00:00.000Z",
    sameIdentityAsActive: "unknown",
  },
  lastRevocation: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
  ...overrides,
});

type Recorded = Record<string, object[]>;

/** `requiredRedirect` stands in for a server that falls back to a fixed port. */
export function fakeApi(
  pending: ManagedConnection = candidateConnection(),
  requiredRedirect?: string,
) {
  const started = (redirectUri: string) => {
    const used = requiredRedirect ?? redirectUri;
    return {
      connectionId: pending.id,
      attemptId: "attempt-1",
      completionSecret: SECRET,
      redirectUri: used,
      authorizationUrl: `https://provider.test/authorize?state=the-state&redirect_uri=${encodeURIComponent(used)}`,
    };
  };
  const calls: Recorded = {};
  const record = (name: string, input: object) => {
    (calls[name] ??= []).push(input);
  };
  const api: ConnectionsApi = {
    list: () => Promise.resolve([pending]),
    listPresets: () => Promise.resolve([]),
    probe: (input) => {
      record("probe", input);
      return Promise.resolve({
        resource: input.resource,
        issuerOrigin: "https://auth.provider.test",
        endpointOrigins: ["https://auth.provider.test"],
        clientRegistration: input.client === undefined ? "cimd" : "supplied",
        supports: { cimd: true, dcr: false },
        overrides: {},
      });
    },
    startLoopback: (input) => {
      record("startLoopback", input);
      return Promise.resolve(started(input.redirectUri));
    },
    startCustomLoopback: (input) => {
      record("startCustomLoopback", input);
      return Promise.resolve(started(input.redirectUri));
    },
    reconnectLoopback: (input) => {
      record("reconnectLoopback", input);
      return Promise.resolve(started(input.redirectUri));
    },
    complete: (input) => {
      record("complete", input);
      return Promise.resolve(pending);
    },
    confirm: (input) => {
      record("confirm", input);
      return Promise.resolve({ ...pending, state: "ready", candidate: null });
    },
    cancel: (input) => {
      record("cancel", input);
      return Promise.resolve({ ...pending, state: "disconnected" });
    },
  };
  return { api, calls };
}

/** A browser that follows the authorization URL straight to the redirect. */
export const redirectingBrowser =
  (query: string) =>
  async (authorizationUrl: string): Promise<void> => {
    const redirectUri = new URL(authorizationUrl).searchParams.get(
      "redirect_uri",
    );
    await fetch(`${redirectUri ?? ""}?${query}`);
  };

export function ports(
  api: ConnectionsApi,
  overrides: Partial<LoopbackSignInPorts> = {},
): LoopbackSignInPorts {
  return {
    api,
    bindListener: bindLoopbackCallback,
    openBrowser: redirectingBrowser(`code=${CODE}&state=the-state`),
    isTty: true,
    prompt: () => Promise.resolve(true),
    ...overrides,
  };
}

export const baseInput = {
  projectId: PROJECT_ID,
  projectRef: PROJECT_REF,
  target: { kind: "connect", preset: "notion", name: "notion" } as const,
  yes: false,
  noBrowser: false,
};
