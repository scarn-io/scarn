import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  OutboundRequestError,
  type GuardedFetch,
  type OutboundRequestFailure,
} from "./guarded-fetch";

/**
 * A `FetchLike` for the MCP SDK on top of {@link GuardedFetch}: the same
 * origin allow list, public-address check and refused redirects, but the
 * response is handed back streaming. One session covers one MCP exchange
 * (initialize, every `tools/list` page, and the closing `DELETE`): its bytes
 * across all responses share one cap, and its requests share one deadline.
 *
 * The SDK wraps transport errors in its own, so the session keeps the first
 * guard failure in `failure`. Passing the cap aborts `signal`, so a request
 * waiting on a streamed reply fails at once instead of at the deadline.
 */

export const GUARDED_MCP_TIMEOUT_MS = 20_000;
export const GUARDED_MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type GuardedMcpFetchOptions = {
  guardedFetch: GuardedFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type GuardedMcpSession = {
  fetch: FetchLike;
  /** Aborts at the deadline, or once the byte cap is passed. */
  signal: AbortSignal;
  /** The first guard failure any request in this session hit. */
  readonly failure: OutboundRequestFailure | null;
  /** Whether the server answered any request with 401. */
  readonly unauthorized: boolean;
};

export class GuardedMcpFetch {
  private readonly guardedFetch: GuardedFetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GuardedMcpFetchOptions) {
    this.guardedFetch = options.guardedFetch;
    this.timeoutMs = options.timeoutMs ?? GUARDED_MCP_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? GUARDED_MCP_MAX_RESPONSE_BYTES;
  }

  session(): GuardedMcpSession {
    const overLimit = new AbortController();
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      overLimit.signal,
    ]);
    const maxBytes = this.maxResponseBytes;
    const guardedFetch = this.guardedFetch;
    let failure: OutboundRequestFailure | null = null;
    let total = 0;
    let unauthorized = false;

    const fail = (error: OutboundRequestError): OutboundRequestError => {
      failure ??= error.failure;
      if (error.failure === "too_large") {
        overLimit.abort(error);
      }
      return error;
    };

    const capped = (body: ReadableStream<Uint8Array>) =>
      body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            total += chunk.byteLength;
            if (total > maxBytes) {
              controller.error(
                fail(
                  new OutboundRequestError(
                    "too_large",
                    "Response is too large",
                  ),
                ),
              );
              return;
            }
            controller.enqueue(chunk);
          },
        }),
      );

    const guarded: FetchLike = async (url, init) => {
      const requestSignal = init?.signal
        ? AbortSignal.any([signal, init.signal])
        : signal;
      let response: Response;
      try {
        response = await guardedFetch.open(url.toString(), {
          method: init?.method ?? "GET",
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          body: typeof init?.body === "string" ? init.body : null,
          signal: requestSignal,
        });
      } catch (error) {
        throw error instanceof OutboundRequestError ? fail(error) : error;
      }
      if (response.status === 401) {
        unauthorized = true;
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && total + declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw fail(
          new OutboundRequestError("too_large", "Response is too large"),
        );
      }
      return new Response(response.body ? capped(response.body) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    return {
      fetch: guarded,
      signal,
      get failure() {
        return failure;
      },
      get unauthorized() {
        return unauthorized;
      },
    };
  }
}
