import { digestsMatch } from "@scarn/core/connections/managed-mcp-connection/domain/managed-oauth-digests";
import type { ArtifactSharingConfig } from "@scarn/core/tasks/artifact-share/domain/artifact-sharing-config";

/** The header CloudFront adds on requests for the content distribution. */
export const CONTENT_ORIGIN_SECRET_HEADER = "x-scarn-content-origin";

/**
 * - `content`: a request for the content origin; only the content routes
 *   (`/s/…`, `/p/…`) answer, everything else is 404.
 * - `api`: a request for the API; the content routes are 404.
 * - `reject`: it claims to be for the content origin with a wrong secret;
 *   answer 404 without serving anything.
 */
export type ContentRequestKind = "content" | "api" | "reject";

const HOST_HEADER_PATTERN = /^[a-z0-9.\-[\]:]+$/i;

/** `host[:port]` lowercased, default port dropped; null for anything else (userinfo, paths). */
const normalizeHost = (host: string, protocol: string): string | null => {
  const trimmed = host.trim();
  if (!HOST_HEADER_PATTERN.test(trimmed)) {
    return null;
  }
  try {
    return new URL(`${protocol}//${trimmed}`).host;
  } catch {
    return null;
  }
};

/**
 * Decides which origin a request is for (plan decision 12, Phase 8 "the Host
 * gate uses a header CloudFront adds"). Pure; the route layer passes in the
 * raw `Host` and `X-Scarn-Content-Origin` request headers.
 *
 * With `contentOriginSecret` set (deployed behind CloudFront), only the
 * secret header counts: the content distribution adds it, and the `Host` the
 * API sees is the origin's, not the viewer's. Without it (local dev, a
 * direct deployment) the `Host` header is compared, host and port, with the
 * content URL's host; default ports are ignored.
 *
 * `X-Forwarded-Host` is never consulted. Any client can set it, and the API
 * origin passes it through, so trusting it would let someone request
 * `https://api…/s/<token>/` with `X-Forwarded-Host: <content host>` and get
 * bundle HTML served from the API's origin, where its scripts run next to the
 * app's cookies; exactly what the separate origin exists to prevent.
 *
 * With sharing disabled the content routes do not exist: always `api`.
 */
export const classifyContentRequest = (input: {
  hostHeader: string | null | undefined;
  originSecretHeader: string | null | undefined;
  config: Pick<
    ArtifactSharingConfig,
    "enabled" | "contentUrl" | "contentOriginSecret"
  >;
}): ContentRequestKind => {
  const { config } = input;
  if (!config.enabled || !config.contentUrl) {
    return "api";
  }

  if (config.contentOriginSecret) {
    if (input.originSecretHeader == null) {
      return "api";
    }
    return digestsMatch(input.originSecretHeader, config.contentOriginSecret)
      ? "content"
      : "reject";
  }

  if (!input.hostHeader) {
    return "api";
  }
  let contentUrl: URL;
  try {
    contentUrl = new URL(config.contentUrl);
  } catch {
    return "api";
  }
  const requestHost = normalizeHost(input.hostHeader, contentUrl.protocol);
  return requestHost !== null && requestHost === contentUrl.host
    ? "content"
    : "api";
};
