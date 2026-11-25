import { Elysia } from "elysia";
import {
  API_CLIENT_HEADER,
  API_CLIENT_VERSION_HEADER,
} from "@scarn/observability/analytics/api-client";
import { getTrustedOrigins, normalizeOrigin } from "./routes/trusted-origin";

const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = `Content-Type, Authorization, ${API_CLIENT_HEADER}, ${API_CLIENT_VERSION_HEADER}`;
const MAX_AGE_SECONDS = "600";

/**
 * Credentialed CORS for the app calling the API from another origin. Only
 * Better Auth's trusted origins are echoed back; any other origin gets no
 * CORS headers, so the browser blocks the response. Preflights are answered
 * here before routing.
 */
export const cors = () =>
  new Elysia({ name: "cors" }).onRequest(({ request, set }) => {
    const origin = request.headers.get("origin");
    if (origin === null) {
      return;
    }

    set.headers["vary"] = "Origin";
    const normalized = normalizeOrigin(origin);
    const allowed =
      normalized !== null && getTrustedOrigins().includes(normalized);
    const isPreflight =
      request.method === "OPTIONS" &&
      request.headers.has("access-control-request-method");

    if (!allowed) {
      return isPreflight
        ? new Response(null, { status: 204, headers: { vary: "Origin" } })
        : undefined;
    }

    set.headers["access-control-allow-origin"] = origin;
    set.headers["access-control-allow-credentials"] = "true";

    if (!isPreflight) {
      return;
    }

    return new Response(null, {
      status: 204,
      headers: {
        vary: "Origin",
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": ALLOWED_METHODS,
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-max-age": MAX_AGE_SECONDS,
      },
    });
  });
