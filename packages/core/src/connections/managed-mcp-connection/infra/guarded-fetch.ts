import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";

/**
 * Outbound HTTP for managed connections. A request may only go to an
 * allow-listed HTTPS origin (certificates are verified by `fetch`), every
 * address the host resolves to must be public, redirects are rejected, the
 * response body is size-capped, and the whole request (body included) is
 * bounded by a timeout. Nothing is retried.
 *
 * The address check runs before each request. `fetch` resolves the host
 * again itself and can't be pinned to the checked address, so a DNS answer
 * that changes between the two lookups isn't caught; the fixed origin allow
 * list is the primary control.
 *
 * `loopbackOrigins` is a test-only allowance for a local fake provider: those
 * exact origins may use plain HTTP and a loopback address. It is only set
 * through DI overrides, never from the environment.
 */

export const GUARDED_FETCH_TIMEOUT_MS = 10_000;
export const GUARDED_FETCH_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * `blocked` and `unreachable` mean nothing was sent: the destination was
 * refused, or the host couldn't be resolved or connected to. The others mean
 * the request may have reached the server.
 */
export type OutboundRequestFailure =
  "blocked" | "unreachable" | "redirect" | "timeout" | "network" | "too_large";

/** Connection errors raised before any request bytes are written. */
const unreachableCode = z.enum([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ConnectionRefused",
]);

const unreachableErrorSchema = z.union([
  z.object({ code: unreachableCode }),
  z.object({ cause: z.object({ code: unreachableCode }) }),
]);

export class OutboundRequestError extends Error {
  constructor(
    public readonly failure: OutboundRequestFailure,
    message: string,
  ) {
    super(message);
    this.name = "OutboundRequestError";
  }
}

/** Every address `hostname` resolves to. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export const systemHostResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

export type GuardedFetchOptions = {
  allowedOrigins: readonly string[];
  loopbackOrigins?: readonly string[];
  resolveHost?: HostResolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type GuardedResponse = {
  status: number;
  headers: Headers;
  /** Reads the body as text, failing with `too_large` past the size cap. */
  text(): Promise<string>;
  discard(): Promise<void>;
};

const blockedAddresses = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
})();

/**
 * True for loopback, private, link-local (including cloud metadata such as
 * 169.254.169.254 and fd00:ec2::254), carrier-grade NAT, documentation,
 * multicast and reserved addresses, and anything that isn't an IP literal.
 */
export const isBlockedAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    return blockedAddresses.check(address, "ipv4");
  }
  if (version === 6) {
    return blockedAddresses.check(address, "ipv6");
  }
  return true;
};

/** Settles with `promise`, or rejects once `signal` aborts, whichever comes first. */
export const abortable = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new OutboundRequestError("timeout", "Request timed out"));
    };
    if (signal.aborted) {
      promise.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"]);

const normalizeOrigin = (origin: string): string => new URL(origin).origin;

export class GuardedFetch {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly loopbackOrigins: ReadonlySet<string>;
  private readonly resolveHost: HostResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GuardedFetchOptions) {
    this.allowedOrigins = new Set(options.allowedOrigins.map(normalizeOrigin));
    for (const origin of this.allowedOrigins) {
      if (!origin.startsWith("https://")) {
        throw new Error(`Guarded fetch origin must be HTTPS: ${origin}`);
      }
    }
    this.loopbackOrigins = new Set(
      (options.loopbackOrigins ?? []).map(normalizeOrigin),
    );
    for (const origin of this.loopbackOrigins) {
      if (!LOOPBACK_HOSTNAMES.has(new URL(origin).hostname)) {
        throw new Error(
          `Loopback allowance must be a loopback origin: ${origin}`,
        );
      }
    }
    this.resolveHost = options.resolveHost ?? systemHostResolver;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GUARDED_FETCH_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? GUARDED_FETCH_MAX_RESPONSE_BYTES;
  }

  isAllowedUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return (
      this.allowedOrigins.has(parsed.origin) ||
      this.loopbackOrigins.has(parsed.origin)
    );
  }

  async request(
    url: string,
    init: {
      method: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<GuardedResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.open(url, { ...init, signal });
    return {
      status: response.status,
      headers: response.headers,
      text: () => this.readCapped(response, signal),
      discard: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  }

  /**
   * The guarded request itself: checks the destination, sends with manual
   * redirects under `init.signal`, and returns the unread response. A
   * redirect is refused with its body discarded. The caller owns the timeout
   * and the body cap.
   */
  async open(
    url: string,
    init: {
      method: string;
      headers?: HeadersInit;
      body?: string | Uint8Array<ArrayBuffer> | null;
      signal: AbortSignal;
    },
  ): Promise<Response> {
    if (!this.isAllowedUrl(url)) {
      throw new OutboundRequestError("blocked", "Destination is not allowed");
    }
    const target = new URL(url);
    if (!this.loopbackOrigins.has(target.origin)) {
      await this.assertPublicHost(target.hostname);
    }

    const { signal } = init;
    let response: Response;
    try {
      response = await abortable(
        this.fetchImpl(target, {
          method: init.method,
          headers: init.headers,
          body: init.body ?? null,
          redirect: "manual",
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof OutboundRequestError) {
        throw error;
      }
      if (!signal.aborted && unreachableErrorSchema.safeParse(error).success) {
        throw new OutboundRequestError(
          "unreachable",
          "Host could not be reached",
        );
      }
      throw this.transportError(signal);
    }

    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new OutboundRequestError("redirect", "Redirects are not followed");
    }
    return response;
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    let addresses: readonly string[];
    try {
      addresses = await this.resolveHost(hostname);
    } catch {
      throw new OutboundRequestError(
        "unreachable",
        "Host could not be resolved",
      );
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new OutboundRequestError(
        "blocked",
        "Host resolves to a non-public address",
      );
    }
  }

  private async readCapped(
    response: Response,
    signal: AbortSignal,
  ): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new OutboundRequestError("too_large", "Response is too large");
    }
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new OutboundRequestError("too_large", "Response is too large");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof OutboundRequestError) {
        throw error;
      }
      throw this.transportError(signal);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private transportError(signal: AbortSignal): OutboundRequestError {
    return signal.aborted
      ? new OutboundRequestError("timeout", "Request timed out")
      : new OutboundRequestError("network", "Request failed");
  }
}
