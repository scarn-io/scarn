import { randomBytes } from "node:crypto";
import {
  DEFAULT_FAKE_MCP_IDENTITY,
  type FakeMcpCall,
  type FakeMcpFaults,
  type FakeMcpIdentity,
  type FakeMcpIssuedCode,
  type FakeMcpIssuedRefreshToken,
  type FakeMcpOptions,
} from "./fake-mcp-oauth-options";
import { FakeMcpClients } from "./fake-mcp-clients";
import { json, s256, sleep } from "./fake-mcp-http";
import { fakeAuthorizationServerMetadata } from "./fake-mcp-metadata";
import { FakeMcpServer } from "./fake-mcp-server";
import { FakeMcpSlack } from "./fake-mcp-slack";
import { FakeMcpRegistrations } from "./fake-mcp-registration";

export * from "./fake-mcp-oauth-options";
export { FAKE_REGISTRATION_CANARY } from "./fake-mcp-registration";

/**
 * A loopback stand-in for a hosted MCP server and its OAuth server:
 * protected-resource and authorization-server metadata, `/authorize`, and
 * `/token` (which, like Notion's, is also the revocation endpoint). By
 * default it behaves like Notion's (CIMD, `iss` on the callback, revocation,
 * Notion's identity fields in the token response); {@link FAKE_MCP_NO_PRESET}
 * turns those off for a server without a preset. With CIMD, `/authorize`
 * auto-approves after fetching and checking the client's CIMD document the
 * way Notion would; with DCR it serves `/register` and `/authorize` and
 * `/token` accept only clients it registered.
 * `grant_type=refresh_token` rotates the refresh token on every use, so a
 * replayed one gets `invalid_grant`. `/mcp` is a minimal Streamable HTTP MCP
 * server (JSON responses only) that accepts only live access tokens: a refresh
 * retires the access token issued with the refresh token it spends. Every call
 * is recorded, and faults can be injected per endpoint. `slackLike` reshapes
 * it like Slack's server (see {@link FakeMcpSlack}).
 */

export class FakeMcpOAuth {
  readonly calls: FakeMcpCall[] = [];
  /** Every access and refresh token `/token` has handed out, for redaction checks. */
  readonly issuedTokens: string[] = [];
  faults: FakeMcpFaults = {};
  identity: FakeMcpIdentity;
  scopes: readonly string[];
  /** Merged over the generated metadata documents, to test mismatches. */
  protectedResourceOverrides: Record<string, unknown> = {};
  authorizationServerOverrides: Record<string, unknown> = {};
  readonly mcp: FakeMcpServer;
  readonly registrations: FakeMcpRegistrations;

  private readonly codes = new Map<string, FakeMcpIssuedCode>();
  /** Every refresh token handed out, and whether it has been redeemed. */
  private readonly refreshTokens = new Map<string, FakeMcpIssuedRefreshToken>();
  private readonly liveAccessTokens = new Set<string>();
  private readonly slowMs: number;
  private readonly clients: FakeMcpClients;
  private readonly issParameterSupported: boolean;
  private readonly revocation: boolean;
  private readonly identityShape: "notion" | "none";
  private readonly slack: FakeMcpSlack | null;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: FakeMcpOptions = {}) {
    this.identity = options.identity ?? DEFAULT_FAKE_MCP_IDENTITY;
    this.scopes = options.scopes ?? ["default"];
    this.slowMs = options.slowMs ?? 2_000;
    this.slack = options.slackLike === true ? new FakeMcpSlack() : null;
    const slackLike = this.slack !== null;
    this.issParameterSupported =
      !slackLike && (options.issParameterSupported ?? true);
    this.revocation = !slackLike && (options.revocation ?? true);
    this.identityShape = slackLike
      ? "none"
      : (options.identityShape ?? "notion");
    this.registrations = new FakeMcpRegistrations(this.slowMs);
    const suppliedClient = options.suppliedClient ?? null;
    this.clients = new FakeMcpClients(
      suppliedClient === null
        ? (options.clientRegistration ?? "cimd")
        : "supplied",
      {
        registrations: this.registrations,
        fetchClientMetadata:
          options.fetchClientMetadata ?? ((url) => fetch(url)),
        strictRedirects: options.strictRedirects ?? false,
        suppliedClient,
      },
    );
    this.mcp = new FakeMcpServer({
      ...(options.toolPrefix === undefined
        ? {}
        : { toolPrefix: options.toolPrefix }),
      slowMs: this.slowMs,
      fault: () => this.faults.mcp,
      clearFault: () => {
        delete this.faults.mcp;
      },
      isLiveAccessToken: (token) => this.liveAccessTokens.has(token),
      resourceMetadataUrl: () =>
        `${this.origin}/.well-known/oauth-protected-resource${this.slack === null ? "/mcp" : ""}`,
    });
  }

  start(): this {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request, "resource"),
    });
    this.slack?.start((request) => this.handle(request, "endpoints"));
    return this;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    await this.slack?.stop();
    this.server = null;
  }

  /** The origin `/authorize` and `/token` are on: a second one when Slack-like. */
  get endpointOrigin(): string {
    return this.slack?.endpointOrigin ?? this.origin;
  }

  /** The resource the protected-resource metadata names, and tokens are issued for. */
  get advertisedResource(): string {
    return this.slack === null ? this.resource : this.origin;
  }

  get origin(): string {
    if (!this.server) {
      throw new Error("Fake MCP OAuth server is not running");
    }
    return `http://127.0.0.1:${String(this.server.port)}`;
  }

  get resource(): string {
    return `${this.origin}/mcp`;
  }

  /** The fake's MCP URL and issuer origin, for a connection's server. */
  get target(): { resource: string; issuerOrigin: string } {
    return { resource: this.resource, issuerOrigin: this.origin };
  }

  reset(): void {
    this.calls.length = 0;
    this.issuedTokens.length = 0;
    this.faults = {};
    this.protectedResourceOverrides = {};
    this.authorizationServerOverrides = {};
    this.codes.clear();
    this.refreshTokens.clear();
    this.liveAccessTokens.clear();
    this.registrations.forget();
    this.mcp.reset();
  }

  callsTo(endpoint: FakeMcpCall["endpoint"]): FakeMcpCall[] {
    return this.calls.filter((call) => call.endpoint === endpoint);
  }

  /** How many `grant_type=refresh_token` requests `/token` has received. */
  get refreshCount(): number {
    return this.callsTo("refresh").length;
  }

  /**
   * Hands out a fresh refresh token without going through `/authorize`, as if
   * a code exchange had issued it.
   */
  issueRefreshToken(
    clientId: string,
    accessToken: string | null = null,
  ): string {
    const refreshToken = `fake-refresh-${randomBytes(12).toString("hex")}`;
    this.refreshTokens.set(refreshToken, {
      clientId,
      resource: this.advertisedResource,
      used: false,
      accessToken,
    });
    this.issuedTokens.push(refreshToken);
    return refreshToken;
  }

  private async handle(
    request: Request,
    served: "resource" | "endpoints",
  ): Promise<Response> {
    const url = new URL(request.url);
    const routes = this.slack === null ? "all" : served;
    if (url.pathname === "/mcp" && routes !== "endpoints") {
      return await this.mcp.handle(request);
    }
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    const body = request.method === "POST" ? await request.text() : "";
    if (request.method === "POST" && url.pathname !== "/register") {
      Object.assign(params, Object.fromEntries(new URLSearchParams(body)));
    }
    const record = (endpoint: FakeMcpCall["endpoint"]) =>
      this.calls.push({
        endpoint,
        method: request.method,
        path: url.pathname,
        params,
      });

    const onResource = routes !== "endpoints";
    const onEndpoints = routes !== "resource";
    if (
      onResource &&
      url.pathname ===
        `/.well-known/oauth-protected-resource${this.slack === null ? "/mcp" : ""}`
    ) {
      record("protected_resource_metadata");
      return json(200, {
        resource: this.advertisedResource,
        authorization_servers: [this.origin],
        scopes_supported: ["default"],
        bearer_methods_supported: ["header"],
        ...this.protectedResourceOverrides,
      });
    }
    if (
      onResource &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      record("authorization_server_metadata");
      return json(200, this.authorizationServerMetadata());
    }
    if (
      onEndpoints &&
      url.pathname === "/authorize" &&
      request.method === "GET"
    ) {
      record("authorize");
      return await this.authorize(params);
    }
    if (onEndpoints && url.pathname === "/token" && request.method === "POST") {
      if (
        this.revocation &&
        params["grant_type"] === undefined &&
        params["token"] !== undefined
      ) {
        record("revoke");
        return await this.revoke();
      }
      const grant =
        params["grant_type"] === "refresh_token" ? "refresh" : "exchange";
      record(grant === "refresh" ? "refresh" : "token");
      const response =
        grant === "refresh"
          ? await this.refresh(params)
          : await this.token(params);
      return this.slack === null
        ? response
        : await this.slack.asSlack(response, grant, this.scopes);
    }
    if (
      url.pathname === "/register" &&
      request.method === "POST" &&
      this.clients.mode === "dcr"
    ) {
      record("register");
      return await this.registrations.register(body, this.faults.register);
    }
    record("unknown");
    return json(404, { error: "not_found" });
  }

  private authorizationServerMetadata(): Record<string, unknown> {
    if (this.slack !== null) {
      return {
        ...this.slack.authorizationServerMetadata(this.origin),
        ...this.authorizationServerOverrides,
      };
    }
    return {
      ...fakeAuthorizationServerMetadata({
        origin: this.origin,
        revocation: this.revocation,
        clientMode: this.clients.mode,
        issParameterSupported: this.issParameterSupported,
      }),
      ...this.authorizationServerOverrides,
    };
  }

  private async authorize(params: Record<string, string>): Promise<Response> {
    const clientId = params["client_id"];
    const redirectUri = params["redirect_uri"];
    if (!clientId || !redirectUri) {
      return json(400, { error: "invalid_request" });
    }
    if (!(await this.clients.allows(clientId, redirectUri))) {
      return json(400, { error: "invalid_client" });
    }
    if (
      params["response_type"] !== "code" ||
      params["code_challenge_method"] !== "S256" ||
      !params["code_challenge"] ||
      !params["state"] ||
      params["resource"] !== this.advertisedResource
    ) {
      return json(400, { error: "invalid_request" });
    }

    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: params["code_challenge"],
      resource: params["resource"],
      used: false,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params["state"]);
    if (this.faults.authorize === "wrong_iss") {
      callback.searchParams.set("iss", "https://evil.example");
    } else if (
      this.issParameterSupported &&
      this.faults.authorize !== "missing_iss"
    ) {
      callback.searchParams.set("iss", this.origin);
    }
    return new Response(null, {
      status: 302,
      headers: { location: callback.toString() },
    });
  }

  private async token(params: Record<string, string>): Promise<Response> {
    if (this.faults.token === "slow") {
      await sleep(this.slowMs);
    }
    if (this.faults.token === "server_error") {
      return json(503, { error: "temporarily_unavailable" });
    }
    if (this.faults.token === "invalid_client") {
      return json(401, { error: "invalid_client" });
    }
    if (!this.clients.knows(params["client_id"])) {
      return json(401, { error: "invalid_client" });
    }
    if (params["grant_type"] !== "authorization_code") {
      return json(400, { error: "unsupported_grant_type" });
    }
    const issued = this.codes.get(params["code"] ?? "");
    if (
      !issued ||
      issued.used ||
      issued.clientId !== params["client_id"] ||
      issued.redirectUri !== params["redirect_uri"] ||
      issued.resource !== params["resource"] ||
      issued.codeChallenge !== s256(params["code_verifier"] ?? "")
    ) {
      return json(400, { error: "invalid_grant" });
    }
    issued.used = true;
    const accessToken = this.issueAccessToken();
    const refreshToken =
      this.faults.token === "no_refresh_token"
        ? null
        : this.issueRefreshToken(issued.clientId, accessToken);

    return json(200, {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
      ...(this.faults.token === "no_scope"
        ? {}
        : { scope: this.scopes.join(" ") }),
      ...(this.identityShape === "notion"
        ? {
            workspace_id: this.identity.workspaceId,
            workspace_name: this.identity.workspaceName,
            owner: {
              type: "user",
              user: { id: this.identity.userId, name: this.identity.userName },
            },
          }
        : {}),
      unrecognized_field: { ignored: true },
    });
  }

  /**
   * Rotates on every use: the presented refresh token is spent and a new one
   * issued, so presenting a spent token again (a replay) gets `invalid_grant`.
   */
  private async refresh(params: Record<string, string>): Promise<Response> {
    const fault = this.faults.refresh;
    if (fault === "slow") {
      await sleep(this.slowMs);
    }
    if (fault === "server_error") {
      return json(503, { error: "temporarily_unavailable" });
    }
    if (fault === "invalid_grant") {
      return json(400, { error: "invalid_grant" });
    }
    if (
      fault === "invalid_client" ||
      !this.clients.knows(params["client_id"])
    ) {
      return json(401, { error: "invalid_client" });
    }
    const issued = this.refreshTokens.get(params["refresh_token"] ?? "");
    if (
      !issued ||
      issued.used ||
      issued.clientId !== params["client_id"] ||
      issued.resource !== params["resource"]
    ) {
      return json(400, { error: "invalid_grant" });
    }
    const rotates = fault !== "no_refresh_token";
    issued.used = rotates;
    if (issued.accessToken !== null) {
      this.liveAccessTokens.delete(issued.accessToken);
    }
    const accessToken = this.issueAccessToken();
    issued.accessToken = rotates ? null : accessToken;
    const refreshToken = rotates
      ? this.issueRefreshToken(issued.clientId, accessToken)
      : null;
    if (fault === "drop_response_after_rotate") {
      await sleep(this.slowMs);
    }

    return json(200, {
      access_token: accessToken,
      token_type: "bearer",
      ...(fault === "no_expires_in" ? {} : { expires_in: 3600 }),
      ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    });
  }

  private issueAccessToken(): string {
    const accessToken = `fake-access-${randomBytes(12).toString("hex")}`;
    this.issuedTokens.push(accessToken);
    this.liveAccessTokens.add(accessToken);
    return accessToken;
  }

  private async revoke(): Promise<Response> {
    if (this.faults.revoke === "slow") {
      await sleep(this.slowMs);
    }
    if (this.faults.revoke === "server_error") {
      return json(503, { error: "temporarily_unavailable" });
    }
    return new Response(null, { status: 200 });
  }
}
