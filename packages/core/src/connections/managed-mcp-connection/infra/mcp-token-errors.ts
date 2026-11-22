import { z } from "zod";
import type { ManagedOAuthRefreshResult } from "../application/oauth-provider";
import type { ManagedConnectionDiscovery } from "../domain/managed-connection-discovery";
import type { ManagedOAuthAttemptFailureCode } from "../domain/managed-oauth-attempt-entity";

/**
 * How a token endpoint's failures are read. A standard server answers with a
 * non-200 status and an OAuth `error` (RFC 6749 §5.2). With the `slack`
 * override a 200 `{ ok: false, error }` is a failure too, classified by
 * Slack's error codes.
 */

type TokenErrors = ManagedConnectionDiscovery["tokenErrors"];

type TokenErrorClass = "rejected" | "client_rejected" | "unknown";

const tokenErrorSchema = z.object({ error: z.string() });

const slackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().optional(),
});

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const oauthErrorClass = (body: string): TokenErrorClass => {
  const parsed = tokenErrorSchema.safeParse(parseJson(body));
  switch (parsed.success ? parsed.data.error : null) {
    case "invalid_grant":
      return "rejected";
    case "invalid_client":
      return "client_rejected";
    default:
      return "unknown";
  }
};

const SLACK_ERROR_CLASSES: Record<string, TokenErrorClass> = {
  invalid_refresh_token: "rejected",
  invalid_grant: "rejected",
  token_revoked: "rejected",
  invalid_client_id: "client_rejected",
  bad_client_secret: "client_rejected",
};

/** The class of a 200 response's error, or null when it is no error. */
const okErrorClass = (
  body: string,
  tokenErrors: TokenErrors,
): TokenErrorClass | null => {
  if (tokenErrors !== "slack") {
    return null;
  }
  const parsed = slackErrorSchema.safeParse(parseJson(body));
  if (!parsed.success) {
    return null;
  }
  return SLACK_ERROR_CLASSES[parsed.data.error ?? ""] ?? "unknown";
};

/** A failed refresh's result, or null when the response is a success to parse. */
export const refreshFailureOf = (
  status: number,
  body: string,
  tokenErrors: TokenErrors,
): ManagedOAuthRefreshResult | null => {
  if (status >= 500) {
    return { status: "server_error" };
  }
  const errorClass =
    status === 200 ? okErrorClass(body, tokenErrors) : oauthErrorClass(body);
  return errorClass === null ? null : { status: errorClass };
};

/** A failed code exchange's failure code, or null when the response is a success to parse. */
export const exchangeFailureOf = (
  status: number,
  body: string,
  tokenErrors: TokenErrors,
): ManagedOAuthAttemptFailureCode | null => {
  if (status >= 500) {
    return "exchange_unknown";
  }
  const errorClass =
    status === 200 ? okErrorClass(body, tokenErrors) : oauthErrorClass(body);
  if (errorClass === null) {
    return null;
  }
  return errorClass === "client_rejected"
    ? "client_configuration"
    : "exchange_failed";
};
