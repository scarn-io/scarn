import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  digestsMatch,
  managedOAuthBrowserSessionDigest,
  managedOAuthStateDigest,
} from "../domain/managed-oauth-digests";
import {
  completeManagedOAuthAttempt,
  unboundManagedOAuthOutcome,
  type CompleteManagedOAuthAttemptDeps,
  type ManagedOAuthCallbackOutcome,
} from "./complete-managed-oauth-attempt";

export type { ManagedOAuthCallbackOutcome } from "./complete-managed-oauth-attempt";

/** Longest single callback parameter accepted; real codes and states are far shorter. */
export const MANAGED_OAUTH_CALLBACK_MAX_PARAM_LENGTH = 2048;
/** Longest raw callback query string accepted. */
export const MANAGED_OAUTH_CALLBACK_MAX_QUERY_LENGTH = 8192;

const CALLBACK_PARAMS = [
  "code",
  "state",
  "iss",
  "error",
  "error_description",
  "error_uri",
] as const;

type CallbackParam = (typeof CALLBACK_PARAMS)[number];

export type HandleManagedOAuthCallbackInput = {
  /** The callback's raw query string, without the leading `?`. */
  query: string;
  /** The signed-in browser session the callback arrived on. */
  session: { userId: UuidV7; sessionId: string };
};

export type HandleManagedOAuthCallbackDeps = CompleteManagedOAuthAttemptDeps;

type ParsedCallback = Partial<Record<CallbackParam, string>>;

const parseCallbackQuery = (query: string): ParsedCallback | null => {
  if (query.length > MANAGED_OAUTH_CALLBACK_MAX_QUERY_LENGTH) {
    return null;
  }
  const parsed: ParsedCallback = {};
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(query)) {
    if (
      seen.has(key) ||
      value.length > MANAGED_OAUTH_CALLBACK_MAX_PARAM_LENGTH
    ) {
      return null;
    }
    seen.add(key);
    if ((CALLBACK_PARAMS as readonly string[]).includes(key)) {
      parsed[key as CallbackParam] = value;
    }
  }
  return parsed;
};

/**
 * Handles the provider's redirect back to Scarn's callback (decisions 7 and
 * 8). The callback must carry a known `state` minted for a browser attempt
 * of this session and actor; a loopback attempt, another session or user, or
 * an unknown `state` all fail the same way, naming no project. The rest is
 * {@link completeManagedOAuthAttempt}.
 */
export const handleManagedOAuthCallback = async (
  input: HandleManagedOAuthCallbackInput,
  deps: HandleManagedOAuthCallbackDeps,
): Promise<ManagedOAuthCallbackOutcome> => {
  const params = parseCallbackQuery(input.query);
  if (!params?.state) {
    return unboundManagedOAuthOutcome();
  }
  const attempt = await deps.managedOAuthAttemptRepo.findByStateDigest(
    managedOAuthStateDigest(params.state),
  );
  if (
    !attempt ||
    attempt.actorUserId !== input.session.userId ||
    attempt.binding.kind !== "browser" ||
    !digestsMatch(
      attempt.binding.sessionDigest,
      managedOAuthBrowserSessionDigest(input.session.sessionId),
    )
  ) {
    return unboundManagedOAuthOutcome();
  }
  return await completeManagedOAuthAttempt(
    attempt,
    {
      ...(params.code === undefined ? {} : { code: params.code }),
      ...(params.iss === undefined ? {} : { iss: params.iss }),
      ...(params.error === undefined ? {} : { error: params.error }),
    },
    deps,
  );
};
