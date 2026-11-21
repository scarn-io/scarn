import { MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH } from "@scarn/sdk/managed-connections";
import { CliError } from "./cli-error";
import { confirmAction } from "./confirm-action";
import type {
  ConnectionsApi,
  CustomConnectionStart,
  ManagedConnection,
  StartedLoopbackAttempt,
} from "./connections-api";
import type {
  BindLoopbackCallback,
  BindLoopbackCallbackInput,
  LoopbackCallbackListener,
  LoopbackCallbackResult,
  LoopbackHost,
} from "./loopback-callback";
import type { BaseReporter } from "./reporter-types";

/**
 * `scarn connections connect` / `reconnect`: a managed MCP connection's OAuth
 * sign-in caught on a loopback listener (decisions 3, 4, 7 and 9).
 *
 * The listener is bound first so its redirect URI (with the OS-chosen port)
 * can be sent to start; the state to expect is then read from the
 * authorization URL. When start answers with another redirect (the fixed
 * fallback port, for a server that won't let a loopback port vary), the
 * listener moves there before the browser opens. A connection with a
 * supplied client has one fixed redirect, so the listener binds exactly that
 * from the start. What the listener catches is posted to the API with the
 * completion secret, and the API does the exchange, so the CLI never sees a
 * token. The completion secret and the code live only in this function's
 * memory and are never printed. The candidate is then shown and confirmed,
 * or cancelled when the user declines or interrupts.
 */

export const LOOPBACK_CALLBACK_PATH = MANAGED_CONNECTION_LOOPBACK_CALLBACK_PATH;

/**
 * What to sign in. A connection with a supplied client carries that client's
 * one redirect, which the CLI must listen on exactly.
 */
export type LoopbackSignInTarget = (
  | { kind: "connect"; preset: string; name: string }
  | { kind: "custom"; custom: CustomConnectionStart }
  | { kind: "reconnect"; connectionId: string }
) & { suppliedRedirectUri?: string | null };

export interface LoopbackSignInPorts {
  api: ConnectionsApi;
  bindListener: BindLoopbackCallback;
  openBrowser(url: string): Promise<void>;
  /** Overrides `confirmAction`'s TTY check and prompt. */
  isTty?: boolean;
  prompt?: (message: string) => Promise<boolean>;
}

export interface LoopbackSignInInput {
  projectId: string;
  /** `owner/slug`, as shown in the confirm question. */
  projectRef: string;
  target: LoopbackSignInTarget;
  yes: boolean;
  noBrowser: boolean;
  reporter: BaseReporter;
  ports: LoopbackSignInPorts;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type LoopbackSignInOutcome =
  | { kind: "confirmed"; connection: ManagedConnection }
  | { kind: "declined"; connection: ManagedConnection };

type Candidate = NonNullable<ManagedConnection["candidate"]>;
type Account = Candidate["account"];

/** Mirrors the settings page's account line. */
export function accountLine(account: Account, label: string): string {
  const { userName, workspaceName } = account;
  if (userName === null && workspaceName === null) {
    return `Connected to ${label} with an unidentified account`;
  }
  const user = userName ?? `an unnamed ${label} user`;
  return workspaceName === null
    ? `Connected as ${user}`
    : `Connected as ${user} in ${workspaceName}`;
}

export const grantedScopesLine = (candidate: Candidate): string =>
  candidate.grantedScopes.length === 0
    ? "Granted scopes: none"
    : `Granted scopes: ${candidate.grantedScopes.join(" ")}`;

/** Mirrors the settings page's shared-authority disclosure. */
export const sharedAuthorityDisclosure = (label: string) =>
  `Anyone who can run steps in this project will be able to act in ${label} as this account.`;

export const confirmQuestion = (projectRef: string) =>
  `Make this connection available to every step in ${projectRef}?`;

function identityNotice(connection: ManagedConnection, candidate: Candidate) {
  const { label } = connection;
  if (connection.account !== null) {
    if (candidate.sameIdentityAsActive === "unknown") {
      return "Scarn can't verify this is the same account as the current connection.";
    }
    return candidate.sameIdentityAsActive
      ? null
      : `This is a different ${label} account from the current connection.`;
  }
  return candidate.account.identityVerified
    ? null
    : `${label} didn't fully identify this account, so Scarn can't verify which account it is.`;
}

function startAttempt(
  input: LoopbackSignInInput,
  redirectUri: string,
): Promise<StartedLoopbackAttempt> {
  const { api } = input.ports;
  const { target, projectId } = input;
  switch (target.kind) {
    case "connect":
      return api.startLoopback({
        projectId,
        preset: target.preset,
        name: target.name,
        redirectUri,
      });
    case "custom":
      return api.startCustomLoopback({
        projectId,
        custom: target.custom,
        redirectUri,
      });
    case "reconnect":
      return api.reconnectLoopback({
        projectId,
        connectionId: target.connectionId,
        redirectUri,
      });
  }
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (state === null || state.length === 0) {
    throw new CliError(
      "connection_request_failed",
      "The authorization URL Scarn returned has no state, so the sign-in can't be checked.",
    );
  }
  return state;
}

async function openOrPrint(
  input: LoopbackSignInInput,
  authorizationUrl: string,
): Promise<void> {
  const { reporter, ports } = input;
  if (input.noBrowser) {
    reporter.info(
      `Open this URL in a browser to sign in:\n${authorizationUrl}`,
    );
    return;
  }
  try {
    await ports.openBrowser(authorizationUrl);
    reporter.info("Opened your browser to sign in.");
  } catch {
    reporter.warn(
      `Could not open a browser automatically. Open this URL to sign in:\n${authorizationUrl}`,
    );
  }
}

function completionBody(caught: LoopbackCallbackResult) {
  const iss = caught.iss === undefined ? {} : { iss: caught.iss };
  return caught.kind === "code"
    ? { state: caught.state, code: caught.code, ...iss }
    : { state: caught.state, error: caught.error, ...iss };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set<LoopbackHost>([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

const isLoopbackHost = (host: string): host is LoopbackHost =>
  LOOPBACK_HOSTS.has(host);

/**
 * Where to listen to catch exactly `redirectUri`, a fixed loopback redirect
 * (decision 4) set by `portFixedBy`.
 */
function fixedListenerInput(
  redirectUri: string,
  portFixedBy: "client" | "server",
): BindLoopbackCallbackInput {
  const required = URL.canParse(redirectUri) ? new URL(redirectUri) : null;
  if (
    required === null ||
    required.protocol !== "http:" ||
    !isLoopbackHost(required.hostname) ||
    required.port === "" ||
    required.search !== "" ||
    required.hash !== ""
  ) {
    throw new CliError(
      "connection_request_failed",
      `Scarn asked for a sign-in redirect the CLI can't listen on: ${redirectUri}`,
    );
  }
  return {
    host: required.hostname,
    port: Number(required.port),
    path: required.pathname,
    portFixedBy,
  };
}

/**
 * The listener for the redirect start chose: `listener` itself, or, when
 * start named another redirect (the server's fixed fallback port), a new one
 * bound exactly there in its place.
 */
async function listenerFor(
  input: LoopbackSignInInput,
  listener: LoopbackCallbackListener,
  redirectUri: string,
): Promise<LoopbackCallbackListener> {
  if (redirectUri === listener.redirectUri) return listener;
  const required = fixedListenerInput(redirectUri, "server");
  listener.close();
  return await input.ports.bindListener(required);
}

/**
 * The first listener: exactly a supplied client's redirect when the target
 * has one, else a free port on `127.0.0.1`.
 */
const initialListenerInput = (
  target: LoopbackSignInTarget,
): BindLoopbackCallbackInput =>
  target.suppliedRedirectUri != null
    ? fixedListenerInput(target.suppliedRedirectUri, "client")
    : { host: "127.0.0.1", port: 0, path: LOOPBACK_CALLBACK_PATH };

async function catchAndComplete(
  input: LoopbackSignInInput,
): Promise<ManagedConnection> {
  let listener = await input.ports.bindListener(
    initialListenerInput(input.target),
  );
  try {
    const started = await startAttempt(input, listener.redirectUri);
    listener = await listenerFor(input, listener, started.redirectUri);
    const expectedState = stateOf(started.authorizationUrl);
    const waiting = listener.waitFor({
      expectedState,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    waiting.catch(() => undefined);
    await openOrPrint(input, started.authorizationUrl);
    const activity = input.reporter.startActivity(
      "Waiting for you to finish signing in…",
    );
    let caught: LoopbackCallbackResult;
    try {
      caught = await waiting;
    } catch (error) {
      activity.fail("Sign-in didn't finish");
      throw error;
    }
    activity.succeed("Sign-in redirect received");
    return await input.ports.api.complete({
      attemptId: started.attemptId,
      completionSecret: started.completionSecret,
      ...completionBody(caught),
    });
  } finally {
    listener.close();
  }
}

/** Runs the sign-in end to end; see the module comment. */
export async function runLoopbackSignIn(
  input: LoopbackSignInInput,
): Promise<LoopbackSignInOutcome> {
  const { reporter, ports, projectId } = input;
  const isTty = ports.isTty ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!input.yes && !isTty) {
    throw new CliError(
      "confirmation_required",
      `${confirmQuestion(input.projectRef)} Not on a TTY, so pass --yes to confirm.`,
    );
  }

  const pending = await catchAndComplete(input);
  const candidate = pending.candidate;
  if (candidate === null) {
    throw new CliError(
      "connection_completion_failed",
      "Scarn finished the sign-in but has no connection waiting for confirmation. Run the command again.",
    );
  }
  const target = { projectId, connectionId: pending.id };
  const cancel = () =>
    ports.api.cancel({ ...target, candidateId: candidate.id });

  reporter.info(accountLine(candidate.account, pending.label));
  reporter.info(grantedScopesLine(candidate));
  if (candidate.missingScopes.length > 0) {
    reporter.warn(
      `${pending.label} didn't grant: ${candidate.missingScopes.join(" ")}. You can still connect; steps can't use what wasn't granted.`,
    );
  }
  const notice = identityNotice(pending, candidate);
  if (notice !== null) reporter.warn(notice);
  reporter.warn(sharedAuthorityDisclosure(pending.label));

  let confirmed: boolean;
  try {
    confirmed =
      input.signal?.aborted === true
        ? false
        : await confirmAction({
            message: confirmQuestion(input.projectRef),
            yes: input.yes,
            isTty,
            ...(ports.prompt === undefined ? {} : { prompt: ports.prompt }),
          });
  } catch (error) {
    await cancel();
    throw error;
  }

  if (!confirmed || input.signal?.aborted === true) {
    const cancelled = await cancel();
    reporter.info(`Cancelled. ${pending.label} was not connected.`);
    return { kind: "declined", connection: cancelled };
  }

  const ready = await ports.api.confirm({
    ...target,
    candidateId: candidate.id,
    fingerprint: candidate.fingerprint,
    expectedVersion: pending.version,
  });
  reporter.success(`${ready.label} is connected as "${ready.name}".`);
  return { kind: "confirmed", connection: ready };
}
