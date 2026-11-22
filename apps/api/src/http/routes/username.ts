import { Elysia } from "elysia";
import { z } from "zod";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import type { AppContext } from "@scarn/core/lib/di";
import { CoreError } from "@scarn/core/lib/errors";
import {
  authUserEntityToContract,
  authUserSchema,
  DrizzleAuthUserRepo,
  getIdentityAuth,
  usernameSchema,
} from "@scarn/identity";
import { apiErrorResponseSchema } from "../../contracts";
import { createSessionAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const availableQuerySchema = z.object({
  u: z.string(),
});

// Body for setting the current user's chosen username. `usernameSchema` applies
// format + reserved-name validation; uniqueness is enforced in the handler.
const setUsernameBodySchema = z.object({
  username: usernameSchema,
});

// Postgres unique-violation SQLSTATE. A lost availability race (two users
// claiming the same name between the `isUsernameTaken` check and the write)
// trips the unique index on `username`; we map it to the same 409 the
// pre-check produces so callers see one consistent "taken" error.
const PG_UNIQUE_VIOLATION = "23505";

// How far to walk the `cause` chain looking for the SQLSTATE. The observed
// depth is 1 (`DrizzleQueryError` -> `PostgresError`); the bound just keeps a
// cyclic `cause` from spinning.
const MAX_CAUSE_DEPTH = 5;

// The SQLSTATE never surfaces on the thrown error itself. Drizzle wraps every
// failed statement in a `DrizzleQueryError` whose `message` is the SQL text and
// whose `cause` is the driver's `PostgresError` — that inner error is the only
// thing carrying `code: "23505"`. Better Auth does not translate it either: the
// adapter rethrows it untouched, so `auth.api.updateUser` rejects with the same
// wrapped shape. Hence the walk down `cause` instead of a flat `err.code` read.
// eslint-disable-next-line local/no-unknown-parameter-type -- error boundary: caught values are `unknown`
const isUniqueViolation = (err: unknown): boolean => {
  let current: unknown = err;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    if ("code" in current && current.code === PG_UNIQUE_VIOLATION) {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }

  return false;
};

const usernameTakenError = () =>
  new CoreError({
    code: "USERNAME_TAKEN",
    message: "That username is already taken.",
    status: 409,
  });

// `valid` reports whether the candidate passes `usernameSchema` (format +
// reserved denylist). `available` is only meaningful when `valid` is true; it is
// false for invalid candidates so callers can treat "not usable" uniformly.
const availableResponseSchema = z.object({
  valid: z.boolean(),
  available: z.boolean(),
});

// Live availability check + set-username used during signup/onboarding.
//
// Auth: both endpoints require an authenticated session (via `createSessionAuthenticated`)
// but NOT an existing username. A just-created OAuth user has a session before
// picking a username, which is exactly when these are called. This keeps the
// endpoints from being anonymous scraping/enumeration surfaces while still being
// reachable before onboarding completes.
export const createUsernameRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createSessionAuthenticated(appContext.createUserAuthorizationService))
    // GET /username/available?u=<candidate> — live format + availability check.
    .get(
      "/username/available",
      {
        query: availableQuerySchema,
        response: responseSchemas({
          200: availableResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "checkUsernameAvailable",
          tags: ["Username"],
        },
      },
      async ({ query }) => {
        const { u } = availableQuerySchema.parse(query);

        const parsed = usernameSchema.safeParse(u);
        if (!parsed.success) {
          return { valid: false, available: false };
        }

        const authUserRepo = new DrizzleAuthUserRepo();
        const taken = await authUserRepo.isUsernameTaken(parsed.data);
        return { valid: true, available: !taken };
      },
    )
    // POST /username — set the authenticated user's username. This one mutation
    // backs both flows:
    //   1. Onboarding ("Choose your username") — first time a social signup
    //      picks a handle; the `user.update.before` hook in `@scarn/identity`
    //      also flips `usernameChosen` to true.
    //   2. Settings rename — an already-onboarded user changes their handle.
    //      `usernameChosen` is already true, so re-setting it is a no-op; the
    //      only effective change is `authUsers.username`. This respects
    //      Approach B: rename touches ONLY the username column — no org.slug
    //      sync, no domain events (identity cannot depend on core).
    //
    // The write goes through Better Auth's `updateUser` rather than straight to
    // the database. `session.cookieCache` serves the session from a signed
    // cookie snapshot, and only Better Auth can re-sign that snapshot — a direct
    // repo write would leave the cached `username`/`usernameChosen` stale for up
    // to `cookieCache.maxAge`. `updateUser` rewrites the snapshot and hands back
    // the `Set-Cookie` headers, which we forward verbatim.
    .post(
      "/username",
      {
        body: setUsernameBodySchema,
        response: responseSchemas({
          200: authUserSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "setUsername",
          tags: ["Username"],
        },
      },
      async ({ body, auth, request, set }) => {
        const { username } = setUsernameBodySchema.parse(body);
        const isFirstPick = !auth.user.usernameChosen;

        const authUserRepo = new DrizzleAuthUserRepo();

        // Re-check availability server-side; the client's prior check is only
        // advisory.
        const taken = await authUserRepo.isUsernameTaken(username);
        if (taken) {
          throw usernameTakenError();
        }

        // `updateUser` runs behind `sessionMiddleware`, so the incoming request
        // headers have to be forwarded for it to resolve a session; it then
        // updates `session.user.id`, which is exactly `auth.userId`.
        //
        // A race that slips between the check above and this write is still
        // caught by the unique index on `username`; map that constraint
        // violation to the same 409 so the client gets a consistent error.
        let headers: Headers;
        try {
          ({ headers } = await getIdentityAuth().api.updateUser({
            body: { username },
            headers: request.headers,
            returnHeaders: true,
          }));
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw usernameTakenError();
          }
          throw err;
        }

        // Better Auth emits TWO cookies here (`session_token` and the
        // `session_data` snapshot), and the snapshot alone can span several
        // chunked cookies. Assigning a single string would silently keep only
        // one, so hand Elysia the whole array — it appends one `Set-Cookie`
        // header per entry (`handleSet` in elysia/dist/adapter/utils).
        const setCookies = headers.getSetCookie();
        if (setCookies.length > 0) {
          set.headers["set-cookie"] = setCookies;
        }

        // Onboarding only: a settings rename (flag already true) is not a
        // funnel step.
        if (isFirstPick) {
          appContext.analytics.capture(
            auth.userId,
            AnalyticsEvents.UsernameChosen,
            {},
          );
        }

        // `updateUser` responds with `{ status: true }` and not the user, so the
        // row is reloaded to keep this endpoint's contract unchanged.
        // Unreachable in practice: the update above just wrote this row. Left as
        // a 500 rather than a declared 404 so the response contract is unchanged.
        const user = await authUserRepo.load(auth.userId);
        if (!user) {
          throw new Error(`Auth user ${auth.userId} vanished after update`);
        }

        return authUserEntityToContract(user);
      },
    );
