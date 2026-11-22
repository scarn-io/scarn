import { managedConnectionDiscoveryKey } from "../domain/managed-connection-discovery";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import { GuardedFetch } from "./guarded-fetch";

/** The part of a connection's server its outbound guard is built from. */
export type ManagedConnectionGuardTarget = Pick<
  ManagedConnectionServer,
  "resource" | "issuerOrigin" | "discovery"
>;

export type ManagedConnectionGuardsOptions = {
  /** Test-only: loopback origins every connection's guard may reach over HTTP. */
  loopbackOrigins?: readonly string[];
  /** Overrides the guard's outbound timeout for `request`. */
  timeoutMs?: number;
};

/**
 * A guard that reaches only `server`'s MCP origin, issuer origin and the
 * `endpointOrigins` its discovery overrides list. Those of them listed in the
 * test-only `loopbackOrigins` are reached as loopback origins over HTTP; any
 * other loopback origin stays unreachable.
 */
export function managedConnectionGuardedFetch(
  server: ManagedConnectionGuardTarget,
  loopbackOrigins: readonly string[],
  timeoutMs?: number,
): GuardedFetch {
  const origins = new Set(
    [
      server.resource,
      server.issuerOrigin,
      ...(server.discovery?.endpointOrigins ?? []),
    ].map((url) => new URL(url).origin),
  );
  const loopback = new Set(
    loopbackOrigins.map((origin) => new URL(origin).origin),
  );
  return new GuardedFetch({
    allowedOrigins: [...origins].filter((origin) => !loopback.has(origin)),
    loopbackOrigins: [...origins].filter((origin) => loopback.has(origin)),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Hands out one {@link GuardedFetch} per connection server (decision 12),
 * cached by its resource, issuer origin and discovery overrides. The OAuth
 * provider, the relay passthrough and the tool lister all take a
 * connection's guard from here, so every outbound call made for a connection
 * can reach only that connection's MCP origin, issuer origin and override
 * endpoint origins.
 */
export class ManagedConnectionGuards {
  private readonly loopbackOrigins: readonly string[];
  private readonly timeoutMs: number | undefined;
  private readonly guards = new Map<string, GuardedFetch>();

  constructor(options: ManagedConnectionGuardsOptions = {}) {
    this.loopbackOrigins = (options.loopbackOrigins ?? []).map(
      (origin) => new URL(origin).origin,
    );
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Whether a guard may be built for `url`'s origin: HTTPS without
   * credentials, or one of the test-only loopback origins.
   */
  reaches(url: string): boolean {
    const parsed = URL.parse(url);
    if (parsed === null || parsed.username !== "" || parsed.password !== "") {
      return false;
    }
    return (
      parsed.protocol === "https:" ||
      this.loopbackOrigins.includes(parsed.origin)
    );
  }

  /** A guard for `server` that isn't cached, for servers no connection uses yet. */
  uncached(server: ManagedConnectionGuardTarget): GuardedFetch {
    return managedConnectionGuardedFetch(
      server,
      this.loopbackOrigins,
      this.timeoutMs,
    );
  }

  for(server: ManagedConnectionGuardTarget): GuardedFetch {
    const key = [
      server.resource,
      server.issuerOrigin,
      managedConnectionDiscoveryKey(server.discovery),
    ].join("|");
    const cached = this.guards.get(key);
    if (cached) {
      return cached;
    }
    const guard = managedConnectionGuardedFetch(
      server,
      this.loopbackOrigins,
      this.timeoutMs,
    );
    this.guards.set(key, guard);
    return guard;
  }
}
