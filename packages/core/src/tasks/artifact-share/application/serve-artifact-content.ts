import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { Logger } from "@scarn/observability/logging";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import { parseRangeHeader } from "@scarn/core/artifacts/range-header";
import type {
  ArtifactBundleRecord,
  ArtifactBundleRepo,
} from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import { isArtifactBundleExpired } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
import { ArtifactShareServedDomainEvent } from "../domain/artifact-share-served.domain-event";
import type { ArtifactSharingConfig } from "../domain/artifact-sharing-config";
import {
  contentErrorPage,
  type ContentErrorKind,
} from "../domain/content-error-pages";
import {
  contentResponseHeaders,
  contentSecurityHeaders,
} from "../domain/content-response-headers";
import {
  parseContentRequestPath,
  type ContentVia,
} from "../domain/content-request-path";
import { verifyPreviewToken } from "../domain/preview-token";
import type { ArtifactShareRepo } from "./artifact-share-repo";
import {
  contentRateLimitKeys,
  type ContentRateLimiter,
} from "./content-rate-limiter";
import { resolveShareToken } from "./resolve-share-token";

/** A content-origin request, already past the origin gate. */
export type ContentRequest = {
  method: "GET" | "HEAD";
  /** The URL's pathname, still percent-encoded. */
  path: string;
  rangeHeader: string | null;
  /** The client's IP for per-IP rate limiting, or null to skip that limit. */
  clientIp: string | null;
  signal?: AbortSignal | undefined;
};

/** A transport-agnostic response: the route copies it onto a `Response`. */
export type ContentResponse = {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | string | null;
};

export type ServeArtifactContentDeps = {
  artifactShareRepo: ArtifactShareRepo;
  artifactBundleRepo: ArtifactBundleRepo;
  artifactSharingConfig: ArtifactSharingConfig;
  objectStore: ObjectStore | null;
  contentRateLimiter: ContentRateLimiter;
  timeProvider: TimeProvider;
  /** The app's URL, allowed to frame content (CSP `frame-ancestors`). */
  appUrl: string | null;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
  dbExecutor?: DbExecutor | undefined;
};

type Grant = {
  bundle: ArtifactBundleRecord;
  shareId: UuidV7 | null;
  rateLimitKey: string;
};

type Failure = { failure: ContentErrorKind; retryAfterSeconds?: number };

const frameAncestor = (appUrl: string | null): string => {
  if (!appUrl) {
    return "'none'";
  }
  try {
    return new URL(appUrl).origin;
  } catch {
    return "'none'";
  }
};

const errorResponse = (
  request: ContentRequest,
  appOrigin: string,
  { failure, retryAfterSeconds }: Failure,
): ContentResponse => {
  const page = contentErrorPage(failure);
  return {
    status: page.status,
    headers: {
      ...contentSecurityHeaders(appOrigin),
      "Content-Type": "text/html; charset=utf-8",
      ...(retryAfterSeconds !== undefined
        ? { "Retry-After": String(retryAfterSeconds) }
        : {}),
    },
    body: request.method === "HEAD" ? null : page.html,
  };
};

const hitRateLimit = (
  limiter: ContentRateLimiter,
  key: string | null,
  now: Date,
): Failure | null => {
  if (key === null) {
    return null;
  }
  const decision = limiter.hit(key, now);
  return decision.allowed
    ? null
    : {
        failure: "rate_limited",
        retryAfterSeconds: decision.retryAfterSeconds,
      };
};

const resolveGrant = async (
  via: ContentVia,
  token: string,
  deps: ServeArtifactContentDeps,
): Promise<Grant | Failure> => {
  if (via === "share") {
    const resolved = await resolveShareToken(token, deps);
    if (!resolved.ok) {
      return {
        failure: resolved.reason === "expired" ? "expired" : "not_found",
      };
    }
    return {
      bundle: resolved.bundle,
      shareId: resolved.share.id,
      rateLimitKey: contentRateLimitKeys({
        shareId: resolved.share.id,
        clientIp: null,
      }).share,
    };
  }

  const { artifactSharingConfig: config } = deps;
  const now = deps.timeProvider.now();
  const claims =
    config.enabled && config.shareSecret
      ? verifyPreviewToken(config.shareSecret, token, now)
      : null;
  if (!claims) {
    return { failure: "not_found" };
  }
  const bundle = await deps.artifactBundleRepo.findByIdIncludingDeleted(
    claims.bundleId,
    deps.dbExecutor,
  );
  if (!bundle || bundle.deletedAt !== null) {
    return { failure: "not_found" };
  }
  if (isArtifactBundleExpired(bundle, now)) {
    return { failure: "expired" };
  }
  if (bundle.status !== "ready") {
    return { failure: "not_found" };
  }
  return { bundle, shareId: null, rateLimitKey: `preview:${bundle.id}` };
};

const findMember = async (
  bundle: ArtifactBundleRecord,
  path: string,
  deps: ServeArtifactContentDeps,
) => {
  try {
    return await deps.artifactBundleRepo.findMember(
      bundle.id,
      path,
      deps.dbExecutor,
    );
  } catch (error) {
    if (error instanceof CoreValidationError) {
      return null;
    }
    throw error;
  }
};

/**
 * Best-effort: serving must not fail because the event could not be
 * published, so failures are logged and swallowed.
 */
const emitServed = async (
  event: ArtifactShareServedDomainEvent,
  deps: ServeArtifactContentDeps,
): Promise<void> => {
  const dispatcher = deps.domainEventDispatcher;
  if (!dispatcher) {
    return;
  }
  try {
    await (deps.dbExecutor ?? getDb()).transaction(async (tx) => {
      await dispatcher.publish([event], tx);
    });
  } catch (error) {
    deps.logger?.error(
      { bundleId: event.payload.bundleId, error },
      "Failed to emit artifact-share-served event",
    );
  }
};

/**
 * Serve one file of a bundle on the content origin (plan Phase 4), for a
 * share link (`/s/<token>/<path>`) or a member preview
 * (`/p/<previewToken>/<path>`). The caller has already checked that the
 * request is for the content origin.
 *
 * - Every failure is a static page that never says whether a token existed:
 *   404 for anything unknown, invalid, revoked, deleted or not ready, 410
 *   for an expired bundle or member, 429 over a rate limit.
 * - Rate limits (decision 15): per client IP before any lookup, then per
 *   share (`share:<id>`) or per previewed bundle (`preview:<id>`). Anonymous
 *   share reads never touch the owner's read cap; a preview's read was
 *   counted when its token was minted (`createArtifactPreview`).
 * - `Range` is honoured for a single range (206, or 416 when unsatisfiable);
 *   every file response says `Accept-Ranges: bytes`.
 * - Every GET that sends a file emits {@link ArtifactShareServedDomainEvent}
 *   with the bytes sent. HEAD sends none and emits nothing.
 */
export const serveArtifactContent = async (
  request: ContentRequest,
  deps: ServeArtifactContentDeps,
): Promise<ContentResponse> => {
  const appOrigin = frameAncestor(deps.appUrl);
  const fail = (failure: Failure) => errorResponse(request, appOrigin, failure);

  const target = parseContentRequestPath(request.path);
  if (target.kind === "not_found") {
    return fail({ failure: "not_found" });
  }
  if (target.kind === "redirect") {
    return {
      status: 308,
      headers: {
        ...contentSecurityHeaders(appOrigin),
        Location: target.location,
      },
      body: null,
    };
  }

  const now = deps.timeProvider.now();
  const ipLimited = hitRateLimit(
    deps.contentRateLimiter,
    request.clientIp ? `ip:${request.clientIp}` : null,
    now,
  );
  if (ipLimited) {
    return fail(ipLimited);
  }

  const grant = await resolveGrant(target.via, target.token, deps);
  if ("failure" in grant) {
    return fail(grant);
  }
  const grantLimited = hitRateLimit(
    deps.contentRateLimiter,
    grant.rateLimitKey,
    now,
  );
  if (grantLimited) {
    return fail(grantLimited);
  }

  const { bundle } = grant;
  const memberPath = target.path ?? bundle.entryPath;
  const member = await findMember(bundle, memberPath, deps);
  if (!member) {
    return fail({ failure: "not_found" });
  }
  if (member.storeRef === null || member.objectKey === null) {
    return fail({ failure: "expired" });
  }
  if (!deps.objectStore) {
    return fail({ failure: "not_found" });
  }

  const range =
    member.sizeBytes === null
      ? null
      : parseRangeHeader(request.rangeHeader, member.sizeBytes);
  const headers = {
    ...contentResponseHeaders({
      appOrigin,
      contentType: member.contentType,
      fileName: memberPath,
    }),
    "Accept-Ranges": "bytes",
  };
  if (range === "unsatisfiable") {
    return {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${String(member.sizeBytes)}`,
      },
      body: null,
    };
  }

  const object = await deps.objectStore.getObjectStream(member.objectKey, {
    range: range ?? undefined,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!object) {
    return fail({ failure: "not_found" });
  }

  const { contentRange } = object;
  const bytes = contentRange
    ? contentRange.end - contentRange.start + 1
    : object.sizeBytes;
  const fileHeaders: Record<string, string> = {
    ...headers,
    "Content-Length": String(bytes),
    ...(contentRange
      ? {
          "Content-Range": `bytes ${String(contentRange.start)}-${String(contentRange.end)}/${String(contentRange.total)}`,
        }
      : {}),
  };
  const status = contentRange ? 206 : 200;

  if (request.method === "HEAD") {
    await object.body.cancel();
    return { status, headers: fileHeaders, body: null };
  }

  await emitServed(
    new ArtifactShareServedDomainEvent(
      {
        projectId: bundle.projectId,
        bundleId: bundle.id,
        shareId: grant.shareId,
        path: memberPath,
        bytes,
        via: target.via,
      },
      now,
    ),
    deps,
  );
  return { status, headers: fileHeaders, body: object.body };
};
