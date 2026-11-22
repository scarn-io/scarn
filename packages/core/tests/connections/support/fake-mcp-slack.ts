import { json } from "./fake-mcp-http";

/**
 * The parts of {@link FakeMcpOAuth} that make it look like Slack's MCP server
 * (fetched 2026-11-20): protected-resource metadata only at the root
 * well-known URL, naming the bare origin as the resource; `/authorize` and
 * `/token` on a second origin (`slack.com` next to `mcp.slack.com`); only
 * `client_secret_post` advertised; no `iss`, revocation, DCR or CIMD; token
 * errors as HTTP 200 `{ ok: false, error }`; and a comma-separated `scope` on
 * refresh.
 */

const SLACK_ERRORS: Record<string, { exchange: string; refresh: string }> = {
  invalid_grant: { exchange: "invalid_code", refresh: "invalid_refresh_token" },
  invalid_client: {
    exchange: "invalid_client_id",
    refresh: "invalid_client_id",
  },
};

export class FakeMcpSlack {
  private server: ReturnType<typeof Bun.serve> | null = null;

  start(handle: (request: Request) => Promise<Response>): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: handle,
    });
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }

  /** The origin `/authorize` and `/token` are served on. */
  get endpointOrigin(): string {
    if (!this.server) {
      throw new Error("Fake Slack endpoint server is not running");
    }
    return `http://127.0.0.1:${String(this.server.port)}`;
  }

  authorizationServerMetadata(issuer: string): Record<string, unknown> {
    return {
      issuer,
      authorization_endpoint: `${this.endpointOrigin}/authorize`,
      token_endpoint: `${this.endpointOrigin}/token`,
      scopes_supported: ["default"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    };
  }

  /**
   * `response` from the standard token endpoint as Slack would answer it:
   * an OAuth error becomes HTTP 200 `{ ok: false, error }` with Slack's error
   * code, a success gains `ok: true` (and on refresh a comma-separated
   * `scope`), and a 5xx is left alone.
   */
  async asSlack(
    response: Response,
    grant: "exchange" | "refresh",
    scopes: readonly string[],
  ): Promise<Response> {
    if (response.status >= 500) {
      return response;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (response.status !== 200) {
      const error = typeof body["error"] === "string" ? body["error"] : "";
      return json(200, {
        ok: false,
        error: SLACK_ERRORS[error]?.[grant] ?? error,
      });
    }
    return json(200, {
      ok: true,
      ...body,
      ...(grant === "refresh" ? { scope: scopes.join(",") } : {}),
    });
  }
}
