/**
 * Serves the background worker's control API on `127.0.0.1`, on a port the
 * OS picks. Every request must carry `Authorization: Bearer <token>`, must
 * not carry an `Origin` header (so no web page can drive the worker), and
 * must name `127.0.0.1:<port>` as its `Host` (so DNS rebinding cannot reach
 * it). The token is 32 random bytes, base64url; it is only ever handed to
 * the caller, which writes it to the private discovery file.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createControlApp, type ControlAppDeps } from "./control-app";
import { SlotLeaseManager } from "../application/slot-lease-manager";
import type { ControlError } from "../contracts/control-api";
import type { SlotPort } from "../contracts/slot-port";

export const CONTROL_SERVER_HOSTNAME = "127.0.0.1";

export type StartControlServerOptions = Omit<ControlAppDeps, "leases"> & {
  /** The supervisor's slot allocator, lent to borrowers through leases. */
  slots: SlotPort;
  leaseTtlMs?: number | undefined;
  /** Fixed token for tests; a fresh random one by default. */
  token?: string | undefined;
};

export type ControlServer = {
  port: number;
  token: string;
  /**
   * Stops accepting requests and returns every lent slot; `force` also cuts
   * open streams and long polls.
   */
  close(options?: { force?: boolean }): Promise<void>;
};

export function generateControlToken(): string {
  return randomBytes(32).toString("base64url");
}

export function startControlServer(
  options: StartControlServerOptions,
): ControlServer {
  const token = options.token ?? generateControlToken();
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const leases = new SlotLeaseManager({
    slots: options.slots,
    ttlMs: options.leaseTtlMs,
  });
  const app = createControlApp({ ...options, leases });
  const server = Bun.serve({
    hostname: CONTROL_SERVER_HOSTNAME,
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const rejection = guard(request, expectedAuthorization, server.port);
      return rejection ?? app.handle(request);
    },
  });
  const port = server.port;
  if (port === undefined) {
    void server.stop(true);
    void leases.close();
    throw new Error("The control server did not get a port.");
  }
  return {
    port,
    token,
    close: async ({ force = false } = {}) => {
      await leases.close();
      await server.stop(force);
    },
  };
}

function guard(
  request: Request,
  expectedAuthorization: Buffer,
  port: number | undefined,
): Response | null {
  if (
    !isAuthorized(request.headers.get("authorization"), expectedAuthorization)
  ) {
    return reject(401, "unauthorized", "Missing or wrong bearer token.");
  }
  if (request.headers.has("origin")) {
    return reject(403, "forbidden", "Requests with an Origin are refused.");
  }
  if (
    request.headers.get("host") !== `${CONTROL_SERVER_HOSTNAME}:${String(port)}`
  ) {
    return reject(403, "forbidden", "Unexpected Host.");
  }
  return null;
}

function isAuthorized(header: string | null, expected: Buffer): boolean {
  if (header === null) return false;
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reject(
  status: number,
  code: ControlError["code"],
  message: string,
): Response {
  return Response.json({ code, message } satisfies ControlError, { status });
}
