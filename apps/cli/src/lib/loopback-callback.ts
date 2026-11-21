import { CliError } from "./cli-error";

/**
 * The CLI's half of a loopback OAuth sign-in (RFC 8252 §7.3): a one-shot local
 * HTTP listener that catches the provider's redirect back to
 * `http://<host>:<port><path>`.
 *
 * Binding and waiting are separate steps because the redirect URI (which
 * carries the port) must be known before the attempt is started, while the
 * `state` to expect is only known after. {@link bindLoopbackCallback} binds the
 * exact host the redirect names (`port: 0` asks the OS for a free port); the
 * returned listener's `waitFor` then accepts the first `GET` on `path` whose
 * `state` matches. Anything else is a 404 and doesn't end the wait. The
 * listener always closes once the wait ends, whether by a callback, the
 * timeout or the abort signal.
 *
 * `localhost` is bound on both `127.0.0.1` and `::1` on the same port, since a
 * browser may resolve it to either; a host without IPv6 binds IPv4 only.
 */

export const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

export type LoopbackHost = "127.0.0.1" | "localhost" | "[::1]";

const bindAddressOf = (host: LoopbackHost): string => {
  switch (host) {
    case "localhost":
    case "127.0.0.1":
      return "127.0.0.1";
    case "[::1]":
      return "::1";
  }
};

export type LoopbackCallbackResult =
  | { kind: "code"; code: string; state: string; iss?: string }
  | { kind: "error"; error: string; state: string; iss?: string };

export interface BindLoopbackCallbackInput {
  host: LoopbackHost;
  /** `0` asks the OS for a free port. */
  port: number;
  path: string;
  /**
   * Who fixed the port, when it can't be changed: a supplied client's
   * redirect URI, or the server's fallback for authorization servers that
   * won't let a loopback port vary.
   */
  portFixedBy?: "client" | "server";
}

export interface WaitForLoopbackCallbackInput {
  expectedState: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LoopbackCallbackListener {
  /** The redirect URI to register with the attempt, with the bound port. */
  readonly redirectUri: string;
  readonly port: number;
  waitFor(input: WaitForLoopbackCallbackInput): Promise<LoopbackCallbackResult>;
  close(): void;
}

export type BindLoopbackCallback = (
  input: BindLoopbackCallbackInput,
) => Promise<LoopbackCallbackListener>;

const DONE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scarn</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem;">
<h1>You can close this tab</h1>
<p>Return to your terminal to finish connecting.</p>
</body>
</html>
`;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
};

const notFound = () => new Response("Not found", { status: 404 });

type Waiter = {
  expectedState: string;
  resolve: (result: LoopbackCallbackResult) => void;
  cancel: () => void;
};

function parseCallback(
  url: URL,
  expectedState: string,
): LoopbackCallbackResult | null {
  const parameters = url.searchParams;
  if (parameters.get("state") !== expectedState) return null;
  const iss = parameters.get("iss");
  const extra = iss === null ? {} : { iss };
  const error = parameters.get("error");
  if (error !== null && error.length > 0) {
    return { kind: "error", error, state: expectedState, ...extra };
  }
  const code = parameters.get("code");
  if (code !== null && code.length > 0) {
    return { kind: "code", code, state: expectedState, ...extra };
  }
  return null;
}

const FIXED_BY = {
  client: "the client's redirect URI",
  server:
    "the provider, which only accepts the sign-in redirect Scarn registered on it",
} as const;

function portInUseError(
  input: BindLoopbackCallbackInput,
  port: number,
  cause: Error,
): CliError {
  const fixed =
    input.portFixedBy === undefined
      ? ""
      : ` The port is fixed by ${FIXED_BY[input.portFixedBy]}, so it can't be changed.`;
  return new CliError(
    "loopback_port_in_use",
    `Port ${String(port)} on ${input.host} is already in use, so Scarn can't catch the sign-in redirect. Stop whatever is using it and try again.${fixed}`,
    { cause },
  );
}

type ServeError = Error & { code?: string };

const isPortInUse = (error: Error): boolean =>
  (error as ServeError).code === "EADDRINUSE";

const asError = (error: Error | string): Error =>
  error instanceof Error ? error : new Error(error);

function tryServe<T>(start: () => T): T | Error {
  try {
    return start();
  } catch (caught) {
    return asError(caught as Error);
  }
}

/** Binds the listener; see the module comment. */
export const bindLoopbackCallback: BindLoopbackCallback = (input) => {
  let waiter: Waiter | null = null;

  const fetchHandler = (request: Request): Response => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== input.path) {
      return notFound();
    }
    if (waiter === null) return notFound();
    const result = parseCallback(url, waiter.expectedState);
    if (result === null) return notFound();
    const { resolve } = waiter;
    waiter = null;
    resolve(result);
    return new Response(DONE_PAGE, { status: 200, headers: PAGE_HEADERS });
  };

  const serve = (hostname: string, port: number) =>
    Bun.serve({ hostname, port, fetch: fetchHandler });

  const servers: Array<ReturnType<typeof serve>> = [];
  const stopServers = () => {
    for (const server of servers.splice(0)) void server.stop();
  };
  const close = () => {
    if (waiter === null) stopServers();
    else waiter.cancel();
  };

  const primary = tryServe(() =>
    serve(bindAddressOf(input.host), input.port),
  );
  if (primary instanceof Error) {
    return Promise.reject(
      isPortInUse(primary)
        ? portInUseError(input, input.port, primary)
        : primary,
    );
  }
  servers.push(primary);
  const port = primary.port ?? input.port;

  if (input.host === "localhost") {
    const secondary = tryServe(() => serve("::1", port));
    if (secondary instanceof Error) {
      if (isPortInUse(secondary)) {
        stopServers();
        return Promise.reject(portInUseError(input, port, secondary));
      }
    } else {
      servers.push(secondary);
    }
  }

  const redirectUri = `http://${input.host}:${String(port)}${input.path}`;

  const waitFor = ({
    expectedState,
    timeoutMs = DEFAULT_LOOPBACK_TIMEOUT_MS,
    signal,
  }: WaitForLoopbackCallbackInput): Promise<LoopbackCallbackResult> =>
    new Promise<LoopbackCallbackResult>((resolve, reject) => {
      const cancelled = () =>
        new CliError(
          "loopback_cancelled",
          "Cancelled before sign-in finished.",
        );
      if (signal?.aborted === true) {
        stopServers();
        reject(cancelled());
        return;
      }
      const finish = () => {
        waiter = null;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stopServers();
      };
      const onAbort = () => {
        finish();
        reject(cancelled());
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new CliError(
            "loopback_timeout",
            `No sign-in redirect arrived within ${String(Math.round(timeoutMs / 1000))} seconds. Run the command again.`,
          ),
        );
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      waiter = {
        expectedState,
        resolve: (result) => {
          finish();
          resolve(result);
        },
        cancel: onAbort,
      };
    });

  return Promise.resolve({ redirectUri, port, waitFor, close });
};
