import { createHash } from "node:crypto";

/** Small HTTP helpers shared by the fake MCP OAuth server's endpoints. */

export const json = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/**
 * Whether `redirectUri` matches one of `registered`: exactly, or, unless
 * `strict`, a registered loopback IP redirect on any port (RFC 8252 §7.3).
 */
export const redirectAllowed = (
  registered: readonly string[],
  redirectUri: string,
  strict: boolean,
): boolean => {
  if (registered.includes(redirectUri)) {
    return true;
  }
  if (strict || !URL.canParse(redirectUri)) {
    return false;
  }
  const requested = new URL(redirectUri);
  return registered.some((uri) => {
    if (!URL.canParse(uri)) {
      return false;
    }
    const allowed = new URL(uri);
    return (
      allowed.protocol === "http:" &&
      LOOPBACK_HOSTS.has(allowed.hostname) &&
      requested.protocol === allowed.protocol &&
      requested.hostname === allowed.hostname &&
      requested.pathname === allowed.pathname &&
      requested.search === allowed.search
    );
  });
};

/** Whether the CIMD document at `clientId` names it, allows `redirectUri` and is a public client. */
export const cimdDocumentAllows = async (
  fetchClientMetadata: (url: string) => Promise<Response>,
  clientId: string,
  redirectUri: string,
  strict: boolean,
): Promise<boolean> => {
  let document: Record<string, unknown>;
  try {
    const response = await fetchClientMetadata(clientId);
    if (response.status !== 200) {
      return false;
    }
    document = (await response.json()) as Record<string, unknown>;
  } catch {
    return false;
  }
  const redirectUris = document["redirect_uris"];
  return (
    document["client_id"] === clientId &&
    Array.isArray(redirectUris) &&
    redirectAllowed(redirectUris as string[], redirectUri, strict) &&
    document["token_endpoint_auth_method"] === "none"
  );
};
