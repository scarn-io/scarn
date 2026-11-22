import { z } from "zod";
import type { ManagedOAuthServerMetadata } from "../application/oauth-provider";
import { managedConnectionAudience } from "../domain/managed-connection-discovery";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type { GuardedFetch } from "./guarded-fetch";

/**
 * Fetches and checks an MCP server's protected-resource metadata (RFC 9728)
 * and its authorization server's metadata (RFC 8414). The metadata may only
 * confirm the connection's stored `resource` (or its `advertisedResource`
 * override), `issuerOrigin` and `endpointOrigins`; it never chooses any.
 * Anything short of what the connect flow relies on (S256 PKCE, refresh
 * tokens, public-client token auth for a client Scarn registers, the
 * connection's client registration method, and `iss` on the callback when
 * the policy asks for it) is rejected.
 */

export class ManagedOAuthDiscoveryError extends Error {
  /** The HTTP status a metadata request answered with, when that was the failure. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ManagedOAuthDiscoveryError";
    this.status = status;
  }
}

/** What a preset may tighten beyond the checks every server gets. */
export type McpOAuthDiscoveryPolicy = {
  /** Reject a server that doesn't advertise `authorization_response_iss_parameter_supported`. */
  requireIssParameter: boolean;
};

const protectedResourceSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
  scopes_supported: z.array(z.string()).optional(),
});

const authorizationServerSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  registration_endpoint: z.string().optional(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  scopes_supported: z.array(z.string()).optional(),
});

const fetchMetadata = async <T>(
  guardedFetch: GuardedFetch,
  url: string,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> => {
  const response = await guardedFetch.request(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (response.status !== 200) {
    await response.discard();
    throw new ManagedOAuthDiscoveryError(
      `${what} metadata request returned ${String(response.status)}`,
      response.status,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    throw new ManagedOAuthDiscoveryError(`${what} metadata is not JSON`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new ManagedOAuthDiscoveryError(
      `${what} metadata is missing or has unsupported ${fields.join(", ")}`,
    );
  }
  return result.data;
};

const requireValue = (
  values: readonly string[],
  required: string,
  field: string,
) => {
  if (!values.includes(required)) {
    throw new ManagedOAuthDiscoveryError(
      `Authorization server metadata ${field} lacks ${required}`,
    );
  }
};

/** `${origin}/.well-known/${suffix}${path}`, with the URL's path inserted after the well-known prefix (RFC 8414 §3.1, RFC 9728 §3.1). */
export const wellKnownUrl = (url: URL, suffix: string): string => {
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
  return `${url.origin}/.well-known/${suffix}${path}`;
};

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isOnOrigin = (url: string, origin: string): boolean =>
  parseUrl(url)?.origin === origin;

/**
 * The issuer the protected-resource metadata lists on `issuerOrigin`: the
 * origin itself when listed, else the only listed issuer on that origin.
 */
const issuerOn = (
  authorizationServers: readonly string[],
  issuerOrigin: string,
): string => {
  if (authorizationServers.includes(issuerOrigin)) {
    return issuerOrigin;
  }
  const onOrigin = authorizationServers.filter((issuer) => {
    const url = parseUrl(issuer);
    return (
      url !== null &&
      url.origin === issuerOrigin &&
      url.search === "" &&
      url.hash === ""
    );
  });
  const [issuer] = onOrigin;
  if (onOrigin.length !== 1 || issuer === undefined) {
    throw new ManagedOAuthDiscoveryError(
      "Protected resource metadata doesn't list the expected issuer",
    );
  }
  return issuer;
};

export type ProtectedResourceMetadata = z.infer<typeof protectedResourceSchema>;
export type AuthorizationServerMetadata = z.infer<
  typeof authorizationServerSchema
>;

/** The protected-resource metadata at `url`, as served. */
export const fetchProtectedResourceMetadata = (
  guardedFetch: GuardedFetch,
  url: string,
): Promise<ProtectedResourceMetadata> =>
  fetchMetadata(
    guardedFetch,
    url,
    protectedResourceSchema,
    "Protected resource",
  );

/** `issuer`'s authorization-server metadata from its path-inserted well-known URL; it must name `issuer`. */
export const fetchAuthorizationServerMetadata = async (
  guardedFetch: GuardedFetch,
  issuer: string,
): Promise<AuthorizationServerMetadata> => {
  const metadata = await fetchMetadata(
    guardedFetch,
    wellKnownUrl(new URL(issuer), "oauth-authorization-server"),
    authorizationServerSchema,
    "Authorization server",
  );
  if (metadata.issuer !== issuer) {
    throw new ManagedOAuthDiscoveryError(
      "Authorization server metadata names a different issuer",
    );
  }
  return metadata;
};

/**
 * The checks every server's authorization-server metadata gets (decision
 * 41): the code flow with S256 PKCE, refresh tokens, public-client token
 * auth unless the client is supplied, `iss` when `policy` asks for it,
 * `clientRegistration`'s method when one is given, and every endpoint
 * within the guard and on `issuerOrigin`, except that the authorization and
 * token endpoints may also be on one of `endpointOrigins`.
 */
export const checkAuthorizationServerMetadata = (
  guardedFetch: GuardedFetch,
  metadata: AuthorizationServerMetadata,
  expected: {
    issuerOrigin: string;
    endpointOrigins?: readonly string[] | undefined;
    clientRegistration: ManagedConnectionServer["clientRegistration"] | null;
    policy: McpOAuthDiscoveryPolicy;
  },
): void => {
  requireValue(
    metadata.response_types_supported,
    "code",
    "response_types_supported",
  );
  requireValue(
    metadata.code_challenge_methods_supported,
    "S256",
    "code_challenge_methods_supported",
  );
  for (const grantType of ["authorization_code", "refresh_token"]) {
    requireValue(
      metadata.grant_types_supported,
      grantType,
      "grant_types_supported",
    );
  }
  if (expected.clientRegistration !== "supplied") {
    requireValue(
      metadata.token_endpoint_auth_methods_supported,
      "none",
      "token_endpoint_auth_methods_supported",
    );
  }
  if (
    expected.policy.requireIssParameter &&
    metadata.authorization_response_iss_parameter_supported !== true
  ) {
    throw new ManagedOAuthDiscoveryError(
      "Authorization server doesn't support the iss callback parameter",
    );
  }
  if (
    expected.clientRegistration === "cimd" &&
    metadata.client_id_metadata_document_supported !== true
  ) {
    throw new ManagedOAuthDiscoveryError(
      "Authorization server doesn't support client ID metadata documents",
    );
  }
  if (
    expected.clientRegistration === "dcr" &&
    metadata.registration_endpoint === undefined
  ) {
    throw new ManagedOAuthDiscoveryError(
      "Authorization server has no registration_endpoint",
    );
  }
  const issuerOnly = [expected.issuerOrigin];
  const endpointOrigins = [...issuerOnly, ...(expected.endpointOrigins ?? [])];
  for (const [field, endpoint, origins] of [
    [
      "authorization_endpoint",
      metadata.authorization_endpoint,
      endpointOrigins,
    ],
    ["token_endpoint", metadata.token_endpoint, endpointOrigins],
    ["revocation_endpoint", metadata.revocation_endpoint, issuerOnly],
    ["registration_endpoint", metadata.registration_endpoint, issuerOnly],
  ] as const) {
    if (
      endpoint !== undefined &&
      (!origins.some((origin) => isOnOrigin(endpoint, origin)) ||
        !guardedFetch.isAllowedUrl(endpoint))
    ) {
      throw new ManagedOAuthDiscoveryError(
        `Authorization server ${field} is not on the allowed origin`,
      );
    }
  }
};

/**
 * Where `server`'s protected-resource metadata is and the resource it must
 * name, after its `resourceMetadataUrl` and `advertisedResource` overrides,
 * both of which must stay on the MCP URL's origin.
 */
const protectedResourceOf = (
  server: ManagedConnectionServer,
): { url: string; audience: string } => {
  const resourceUrl = new URL(server.resource);
  const { resourceMetadataUrl } = server.discovery ?? {};
  const audience = managedConnectionAudience(server);
  if (
    (resourceMetadataUrl !== undefined &&
      !isOnOrigin(resourceMetadataUrl, resourceUrl.origin)) ||
    !isOnOrigin(audience, resourceUrl.origin)
  ) {
    throw new ManagedOAuthDiscoveryError(
      "The connection's discovery overrides leave the MCP server's origin",
    );
  }
  return {
    url:
      resourceMetadataUrl ??
      wellKnownUrl(resourceUrl, "oauth-protected-resource"),
    audience,
  };
};

export const fetchMcpOAuthMetadata = async (
  guardedFetch: GuardedFetch,
  server: ManagedConnectionServer,
  policy: McpOAuthDiscoveryPolicy,
): Promise<ManagedOAuthServerMetadata> => {
  const { url, audience } = protectedResourceOf(server);
  const resourceMetadata = await fetchProtectedResourceMetadata(
    guardedFetch,
    url,
  );
  if (resourceMetadata.resource !== audience) {
    throw new ManagedOAuthDiscoveryError(
      "Protected resource metadata names a different resource",
    );
  }
  const issuer = issuerOn(
    resourceMetadata.authorization_servers,
    server.issuerOrigin,
  );
  const metadata = await fetchAuthorizationServerMetadata(guardedFetch, issuer);
  checkAuthorizationServerMetadata(guardedFetch, metadata, {
    issuerOrigin: server.issuerOrigin,
    endpointOrigins: server.discovery?.endpointOrigins,
    clientRegistration: server.clientRegistration,
    policy,
  });

  return {
    issuer: metadata.issuer,
    resource: audience,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    revocationEndpoint: metadata.revocation_endpoint ?? null,
    registrationEndpoint: metadata.registration_endpoint ?? null,
    issParameterSupported:
      metadata.authorization_response_iss_parameter_supported === true,
    scopesSupported: resourceMetadata.scopes_supported ?? [],
  };
};
