import type { ManagedConnectionServer } from "../domain/managed-connection-server";

/**
 * `unavailable`: nothing usable came back (refused destination, unreachable
 * host, redirect, transport error). `timeout`: the call's signal or the idle
 * limit cut the request before a response arrived. Neither carries anything
 * the provider sent.
 */
export type ManagedMcpPassthroughFailure = "unavailable" | "timeout";

/** The connection server a call goes to: its MCP `resource`, through a guard allowed only it and `issuerOrigin`. */
export type ManagedMcpServerTarget = Pick<
  ManagedConnectionServer,
  "resource" | "issuerOrigin"
>;

export type ManagedMcpPassthroughRequest = {
  server: ManagedMcpServerTarget;
  method: "POST" | "DELETE";
  /** The caller's headers; only the allow-listed ones are sent. */
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | null;
  accessToken: string;
  /** Aborts the upstream request, and the response stream once it is open. */
  signal: AbortSignal;
};

export type ManagedMcpPassthroughResult =
  | {
      /** A 2xx response, its body handed back unread. */
      kind: "forwarded";
      status: number;
      /** Only the allow-listed response headers. */
      headers: Headers;
      body: ReadableStream<Uint8Array> | null;
      /** Settles once the body has ended, failed or been cancelled. */
      closed: Promise<void>;
    }
  | {
      /** A non-2xx response, its body discarded unread. */
      kind: "rejected";
      status: number;
    }
  | { kind: "failed"; failure: ManagedMcpPassthroughFailure };

/** Forwards one relayed MCP request to its connection's MCP resource. */
export interface ManagedMcpPassthrough {
  /** The most one call may last, response stream included. */
  readonly callTimeoutMs: number;
  forward(
    request: ManagedMcpPassthroughRequest,
  ): Promise<ManagedMcpPassthroughResult>;
}
