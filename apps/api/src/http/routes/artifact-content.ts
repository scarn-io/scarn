import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";
import {
  classifyContentRequest,
  CONTENT_ORIGIN_SECRET_HEADER,
} from "@scarn/core/tasks/artifact-share/domain/content-origin-gate";
import { contentErrorPage } from "@scarn/core/tasks/artifact-share/domain/content-error-pages";
import { contentSecurityHeaders } from "@scarn/core/tasks/artifact-share/domain/content-response-headers";
import { serveArtifactContent } from "@scarn/core/tasks/artifact-share/application/serve-artifact-content";
import { getRequestClientIp } from "../client-ip";

/** Header CloudFront sets to the viewer's `ip:port` (IPv6 unbracketed). */
const CLOUDFRONT_VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";

const stripPort = (viewerAddress: string): string | null => {
  const trimmed = viewerAddress.trim();
  const colon = trimmed.lastIndexOf(":");
  const ip = colon > 0 ? trimmed.slice(0, colon) : trimmed;
  return ip.replace(/^\[|\]$/g, "") || null;
};

/**
 * The client IP used for per-IP rate limiting on the content origin.
 *
 * `X-Forwarded-For` is never trusted: any client can prepend to it. Behind
 * CloudFront (the request carried the origin secret, so CloudFront set it),
 * `CloudFront-Viewer-Address` is the viewer's address, which CloudFront
 * overwrites (the distribution must forward it; without it the IP is null,
 * since the socket peer would be a CloudFront edge). Otherwise it is the
 * network peer the entry point recorded (`setRequestClientIp`: Bun's socket
 * peer, a Function URL's `sourceIp`, Cloudflare's `CF-Connecting-IP`). When
 * none is known (`app.handle` in tests) it is null and only the per-share
 * limit applies.
 */
export const contentClientIp = (
  request: Request,
  viaCloudFront: boolean,
): string | null => {
  if (viaCloudFront) {
    const viewer = request.headers.get(CLOUDFRONT_VIEWER_ADDRESS_HEADER);
    return viewer ? stripPort(viewer) : null;
  }
  return getRequestClientIp(request);
};

const notFound = (appUrl: string | null): Response => {
  const page = contentErrorPage("not_found");
  let appOrigin = "'none'";
  try {
    appOrigin = appUrl ? new URL(appUrl).origin : appOrigin;
  } catch {
    // keep 'none'
  }
  return new Response(page.html, {
    status: page.status,
    headers: {
      ...contentSecurityHeaders(appOrigin),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
};

const serve = async (
  appContext: AppContext,
  request: Request,
): Promise<Response> => {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return notFound(appContext.appUrl);
  }
  const result = await serveArtifactContent(
    {
      method,
      path: new URL(request.url).pathname,
      rangeHeader: request.headers.get("range"),
      clientIp: contentClientIp(
        request,
        appContext.artifactSharingConfig.contentOriginSecret !== null,
      ),
      signal: request.signal,
    },
    {
      artifactShareRepo: appContext.artifactShareRepo,
      artifactBundleRepo: appContext.artifactBundleRepo,
      artifactSharingConfig: appContext.artifactSharingConfig,
      objectStore: appContext.objectStore,
      contentRateLimiter: appContext.contentRateLimiter,
      timeProvider: appContext.timeProvider,
      appUrl: appContext.appUrl,
      domainEventDispatcher: appContext.domainEventDispatcher,
      logger: appContext.logger,
    },
  );
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
};

/**
 * The content origin (plan decision 12, Phase 4): share links
 * (`/s/<token>/<path>`) and member previews (`/p/<previewToken>/<path>`),
 * served at the root of the content host, not under `/api`.
 *
 * This is a request hook, mounted first in `createAppCore` (before CORS,
 * auth, OpenAPI and every route), that classifies each request with
 * `classifyContentRequest`:
 *
 * - `content` (the origin secret header matched, or without a secret the
 *   `Host` is the content host): the request is answered here and never
 *   reaches an API route. Anything other than `GET`/`HEAD` on `/s/…` or
 *   `/p/…` is the static 404 page. No credentialed CORS is added; content
 *   responses carry `Access-Control-Allow-Origin: *` themselves.
 * - `reject` (the secret header is present but wrong): 404.
 * - `api`: falls through to the API, where no `/s/…` or `/p/…` content
 *   routes exist (the hosted `/api/s/:code` redirect is unrelated).
 *
 * Every entry point (Bun, both Lambda handlers, the Cloudflare Worker) goes
 * through `createAppCore`, so all of them serve the content origin.
 */
export const createArtifactContentGate = (appContext: AppContext) =>
  new Elysia({ name: "artifact-content-gate" }).onRequest(({ request }) => {
    const kind = classifyContentRequest({
      hostHeader: request.headers.get("host") ?? new URL(request.url).host,
      originSecretHeader: request.headers.get(CONTENT_ORIGIN_SECRET_HEADER),
      config: appContext.artifactSharingConfig,
    });
    if (kind === "api") {
      return;
    }
    if (kind === "reject") {
      return notFound(appContext.appUrl);
    }
    return serve(appContext, request);
  });
