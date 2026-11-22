import { Elysia } from "elysia";
import {
  getAccessJwtVerifier,
  getIdentityAuth,
  isJwtShaped,
  type AuthenticatedUser,
} from "@scarn/identity";
import { CoreError } from "@scarn/core/lib/errors";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ANONYMOUS_ACTOR_ID } from "@scarn/core/access/authorization/anonymous-actor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";

type ResolvedAuth = { userId: UuidV7; user: AuthenticatedUser };

const unauthorized = (message: string) =>
  new CoreError({ code: "UNAUTHORIZED", message, status: 401 });

const readBearerJwt = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && isJwtShaped(token) ? token : null;
};

const toAuthenticatedUser = (user: {
  id: string;
  email: string;
  name: string;
  username?: unknown;
  usernameChosen?: unknown;
}): AuthenticatedUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  username: typeof user.username === "string" ? user.username : null,
  usernameChosen: user.usernameChosen === true,
});

/**
 * Resolves the caller from an access JWT bearer or, failing that shape, from
 * a Better Auth session (cookie or session-token bearer). A JWT that fails
 * verification is a 401 and never falls back to the session lookup, so a
 * client holding an expired token learns to refresh it.
 */
const resolveAuth = async (request: Request): Promise<ResolvedAuth | null> => {
  const jwt = readBearerJwt(request);
  if (jwt) {
    const verified = await getAccessJwtVerifier().verify(jwt);
    if (!verified) {
      throw unauthorized("Invalid or expired access token");
    }
    return { userId: parseUuidV7(verified.userId), user: verified.user };
  }

  const session = await getIdentityAuth().api.getSession({
    headers: request.headers,
  });
  if (!session) return null;
  return {
    userId: parseUuidV7(session.user.id),
    user: toAuthenticatedUser(session.user),
  };
};

/**
 * Requires a caller, identified by an access JWT or a session. `auth.user`
 * carries only the fields an access JWT holds.
 */
export const createAuthenticated = (
  createUserAuthz: (actorId: UuidV7) => UserAuthorizationService,
) =>
  new Elysia({ name: "authenticated" }).derive(
    "plugin",
    async ({ request }) => {
      const resolved = await resolveAuth(request);
      if (!resolved) {
        throw unauthorized("Authentication required");
      }

      return {
        auth: {
          userId: resolved.userId,
          user: resolved.user,
          userAuthz: createUserAuthz(resolved.userId),
        },
      };
    },
  );

/**
 * Requires a live Better Auth session, for routes that call back into Better
 * Auth on the caller's behalf (e.g. `updateUser`) and so cannot run on an
 * access JWT. A JWT bearer is rejected with a 401 rather than looked up.
 */
export const createSessionAuthenticated = (
  createUserAuthz: (actorId: UuidV7) => UserAuthorizationService,
) =>
  new Elysia({ name: "session-authenticated" }).derive(
    "plugin",
    async ({ request }) => {
      if (readBearerJwt(request)) {
        throw unauthorized(
          "This endpoint requires a session; send the session token, not an access token",
        );
      }

      const session = await getIdentityAuth().api.getSession({
        headers: request.headers,
      });

      if (!session) {
        throw unauthorized("Authentication required");
      }

      const userId = parseUuidV7(session.user.id);
      return {
        auth: {
          userId,
          user: session.user,
          session: session.session,
          userAuthz: createUserAuthz(userId),
        },
      };
    },
  );

/**
 * Like {@link createAuthenticated}, but never 401s on missing credentials.
 * Reserved for routes that must serve genuinely unauthenticated requests —
 * reading a public project's work items, executions, logs, artifacts, and
 * comments (see issue #149). Missing credentials resolve to the synthetic
 * `ANONYMOUS_ACTOR_ID`, and `auth.user` is `null`. An access JWT that fails
 * verification is still a 401, never the anonymous actor.
 *
 * This does NOT make every route in a group anonymous-safe: it only defers
 * the "who is this?" decision to `requireProjectPermission`
 * (`assertProjectPermission`), which grants `:read` permissions on public
 * projects to any actor and otherwise denies the anonymous actor with 401
 * (never a membership, so never authorized to write or to read a private
 * project) — the same status a missing session gets today. Only apply this
 * to route groups where every handler in the group ultimately funnels
 * through that check; never to a route (e.g. `POST /projects`) that grants
 * access purely from `userAuthz.actorId` without checking project
 * membership first.
 */
export const createOptionallyAuthenticated = (
  createUserAuthz: (actorId: UuidV7) => UserAuthorizationService,
) =>
  new Elysia({ name: "optionally-authenticated" }).derive(
    "plugin",
    async ({ request }) => {
      const resolved = await resolveAuth(request);
      const userId = resolved?.userId ?? ANONYMOUS_ACTOR_ID;
      return {
        auth: {
          userId,
          user: resolved?.user ?? null,
          userAuthz: createUserAuthz(userId),
        },
      };
    },
  );
