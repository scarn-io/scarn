import type {
  ManagedMcpPassthrough,
  ManagedMcpPassthroughRequest,
  ManagedMcpPassthroughResult,
} from "../application/managed-mcp-passthrough";
import { abortable, OutboundRequestError } from "./guarded-fetch";
import type { ManagedConnectionGuards } from "./managed-connection-guards";

/**
 * The relay's raw passthrough (decisions 8 and 14) on top of
 * the connection's guard from {@link ManagedConnectionGuards}: only the
 * connection's MCP origin and issuer origin, public addresses only, and
 * refused redirects. The destination is always the connection's MCP
 * resource, the caller's body is sent as given, and a 2xx body is streamed
 * back byte for byte. Only allow-listed headers cross in either direction;
 * the bearer is always the server's access token.
 *
 * Each call is bounded by `callTimeoutMs` from the start of the request and
 * by `idleTimeoutMs` while waiting on the provider (for the response head or
 * the next chunk). A consumer that stops reading isn't counted as idle. When
 * either limit passes or the caller's signal aborts, the upstream request is
 * aborted and the stream handed back errors.
 */

export const MANAGED_RELAY_CALL_TIMEOUT_MS = 4 * 60_000;
export const MANAGED_RELAY_IDLE_TIMEOUT_MS = 60_000;

export const MANAGED_RELAY_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

export const MANAGED_RELAY_RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

export type GuardedMcpPassthroughOptions = {
  guards: ManagedConnectionGuards;
  callTimeoutMs?: number;
  idleTimeoutMs?: number;
};

const pick = (source: Headers, names: readonly string[]): Headers => {
  const picked = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) {
      picked.set(name, value);
    }
  }
  return picked;
};

/** Aborts once `ms` pass while armed; disarmed time doesn't count. */
class IdleTimer {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ms: number) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.controller.abort(
        new OutboundRequestError("timeout", "The provider stopped responding"),
      );
    }, this.ms);
  }

  disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class GuardedMcpPassthrough implements ManagedMcpPassthrough {
  private readonly guards: ManagedConnectionGuards;
  readonly callTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: GuardedMcpPassthroughOptions) {
    this.guards = options.guards;
    this.callTimeoutMs = options.callTimeoutMs ?? MANAGED_RELAY_CALL_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? MANAGED_RELAY_IDLE_TIMEOUT_MS;
  }

  async forward(
    request: ManagedMcpPassthroughRequest,
  ): Promise<ManagedMcpPassthroughResult> {
    const idle = new IdleTimer(this.idleTimeoutMs);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(this.callTimeoutMs),
      idle.signal,
    ]);
    const headers = pick(request.headers, MANAGED_RELAY_REQUEST_HEADERS);
    headers.set("authorization", `Bearer ${request.accessToken}`);

    let response: Response;
    idle.arm();
    try {
      response = await this.guards
        .for(request.server)
        .open(request.server.resource, {
          method: request.method,
          headers,
          body: request.body,
          signal,
        });
    } catch (error) {
      idle.disarm();
      if (error instanceof OutboundRequestError) {
        return {
          kind: "failed",
          failure: error.failure === "timeout" ? "timeout" : "unavailable",
        };
      }
      throw error;
    }
    idle.disarm();

    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "rejected", status: response.status };
    }

    const responseHeaders = pick(
      response.headers,
      MANAGED_RELAY_RESPONSE_HEADERS,
    );
    if (!response.body) {
      return {
        kind: "forwarded",
        status: response.status,
        headers: responseHeaders,
        body: null,
        closed: Promise.resolve(),
      };
    }
    const { body, closed } = this.relayBody(response.body, signal, idle);
    return {
      kind: "forwarded",
      status: response.status,
      headers: responseHeaders,
      body,
      closed,
    };
  }

  private relayBody(
    upstream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    idle: IdleTimer,
  ): { body: ReadableStream<Uint8Array>; closed: Promise<void> } {
    const reader = upstream.getReader();
    let settle: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    let failure: OutboundRequestError | null = null;
    let sink: ReadableStreamDefaultController<Uint8Array> | null = null;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      idle.disarm();
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const fail = (error: OutboundRequestError) => {
      if (finished) {
        return;
      }
      failure = error;
      reader.cancel().catch(() => undefined);
      sink?.error(error);
      finish();
    };
    const onAbort = () => {
      fail(new OutboundRequestError("timeout", "Request timed out"));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          sink = controller;
          if (failure) {
            controller.error(failure);
          }
        },
        async pull(controller) {
          idle.arm();
          try {
            const { done, value } = await abortable(reader.read(), signal);
            idle.disarm();
            if (done) {
              controller.close();
              finish();
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            idle.disarm();
            fail(
              error instanceof OutboundRequestError
                ? error
                : new OutboundRequestError("network", "Request failed"),
            );
          }
        },
        async cancel() {
          await reader.cancel().catch(() => undefined);
          finish();
        },
      },
      { highWaterMark: 0 },
    );
    return { body, closed };
  }
}
