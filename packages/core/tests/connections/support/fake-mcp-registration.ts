import { randomBytes } from "node:crypto";
import { json, sleep } from "./fake-mcp-http";
import type { FakeMcpRegisterFault } from "./fake-mcp-oauth-options";

/**
 * A value the fake puts in every registration response, standing in for a
 * registration access token. It must never reach a log or an API response.
 */
export const FAKE_REGISTRATION_CANARY = "canary-registration-access-token";

/**
 * The fake's RFC 7591 registration endpoint and the clients it has issued.
 * A client it forgets (as a server that deleted it would) is unknown from
 * then on, so `/token` answers `invalid_client` for it.
 */
export class FakeMcpRegistrations {
  /** Each live client's registered redirect URIs. */
  private readonly clients = new Map<string, readonly string[]>();
  private readonly slowMs: number;

  constructor(slowMs: number) {
    this.slowMs = slowMs;
  }

  knows(clientId: string | undefined): boolean {
    return clientId !== undefined && this.clients.has(clientId);
  }

  /** Every client ID issued and not yet forgotten. */
  get registered(): string[] {
    return [...this.clients.keys()];
  }

  /** The redirect URIs `clientId` was registered with; empty when unknown. */
  redirectUrisOf(clientId: string): readonly string[] {
    return this.clients.get(clientId) ?? [];
  }

  forget(): void {
    this.clients.clear();
  }

  async register(
    body: string,
    fault: FakeMcpRegisterFault | undefined,
  ): Promise<Response> {
    if (fault === "slow") {
      await sleep(this.slowMs);
    }
    if (fault === "server_error") {
      return json(503, { error: "temporarily_unavailable" });
    }
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid_client_metadata" });
    }
    const redirectUris = request["redirect_uris"];
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => typeof uri === "string")
    ) {
      return json(400, { error: "invalid_redirect_uri" });
    }
    const clientId = `fake-dcr-client-${randomBytes(8).toString("hex")}`;
    this.clients.set(clientId, redirectUris);
    return json(201, {
      ...request,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      registration_access_token: FAKE_REGISTRATION_CANARY,
      registration_client_uri: `https://fake.example/register/${clientId}`,
      ...(fault === "client_secret"
        ? { client_secret: FAKE_REGISTRATION_CANARY }
        : {}),
      ...(fault === "other_auth_method"
        ? { token_endpoint_auth_method: "client_secret_basic" }
        : {}),
      ...(fault === "other_redirect_uris"
        ? {
            redirect_uris: [...redirectUris, "https://evil.example/callback"],
          }
        : {}),
    });
  }
}
