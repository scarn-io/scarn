import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  bearer,
  deviceAuthorization,
  jwt,
  organization,
} from "better-auth/plugins";
import type { GithubProfile } from "better-auth/social-providers";
import { count, eq } from "drizzle-orm";
import * as analyticsServer from "@scarn/observability/analytics/server";
import type { SignupProvider } from "@scarn/observability/analytics/events";
import { ACCESS_JWT_AUDIENCE, toAccessClaims } from "./access-jwt";
import { currentDb, getDb } from "./db";
import { ensurePersonalOrganization } from "./personal-organization";
import {
  getAppUrl,
  getBetterAuthBaseUrl,
  getBetterAuthCookieDomain,
  getBetterAuthSecret,
  getBetterAuthTrustedOrigins,
  getDeviceAuthInterval,
  getEmailPasswordLoginEnabled,
  getGitHubAppOAuthConfig,
  getGoogleOAuthConfig,
  getIdentityAppName,
  getPosthogServerHost,
  getPosthogServerKey,
} from "./env";
import { authAccounts, authUsers, betterAuthDrizzleSchema } from "./db/schema";
import { createAuthId } from "../authentication/domain/auth-id";
import { usernameSchema } from "../authentication/contracts/auth-contracts";

const SIGNUP_PROVIDERS: ReadonlySet<SignupProvider> = new Set<SignupProvider>([
  "github",
  "google",
  "email",
]);

const toSignupProvider = (providerId: string): SignupProvider =>
  SIGNUP_PROVIDERS.has(providerId as SignupProvider)
    ? (providerId as SignupProvider)
    : "email";

export const createIdentityAuth = () => {
  const baseURL = getBetterAuthBaseUrl();
  const appUrl = getAppUrl();
  const cookieDomain = getBetterAuthCookieDomain();
  const cliClientId = "scarn-cli";
  const githubAppOAuth = getGitHubAppOAuthConfig();
  const googleOAuth = getGoogleOAuthConfig();
  const posthogKey = getPosthogServerKey();
  const posthogHost = getPosthogServerHost();
  if (posthogKey && posthogHost) {
    analyticsServer.init({ key: posthogKey, host: posthogHost });
  }
  const socialProviders = {
    ...(githubAppOAuth
      ? {
          github: {
            clientId: githubAppOAuth.clientId,
            clientSecret: githubAppOAuth.clientSecret,
            mapProfileToUser: (profile: GithubProfile) => ({
              githubLogin: profile.login,
            }),
          },
        }
      : {}),
    ...(googleOAuth
      ? {
          google: {
            clientId: googleOAuth.clientId,
            clientSecret: googleOAuth.clientSecret,
          },
        }
      : {}),
  };
  const trustedProviders = [
    ...(githubAppOAuth ? ["github"] : []),
    ...(googleOAuth ? ["google"] : []),
  ];

  return betterAuth({
    secret: getBetterAuthSecret(),
    appName: getIdentityAppName(),
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: getBetterAuthTrustedOrigins(),
    database: drizzleAdapter(currentDb, {
      provider: "pg",
      schema: betterAuthDrizzleSchema,
    }),
    socialProviders:
      Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
    // No mail transport, so addresses stay unverified. Better Auth's default
    // `requireLocalEmailVerified` keeps a social sign-in from implicitly
    // linking onto such an account.
    emailAndPassword: {
      enabled: getEmailPasswordLoginEnabled(),
      requireEmailVerification: false,
    },
    // `username` is a globally-unique, mutable handle. Registering it as an
    // additional user field lets Better Auth persist and update it through the
    // auth layer (signup, session user, account updates). It is NOT required:
    // OAuth/social signups create the user row before a username is chosen, so
    // the row starts with a null username and the user picks one during
    // onboarding via the set-username endpoint.
    user: {
      additionalFields: {
        username: {
          type: "string",
          required: false,
          input: true,
          // Better Auth mounts its own `POST /api/auth/update-user`, which
          // accepts arbitrary additional fields and never sees the `/username`
          // route's zod body schema. A field-level validator is therefore the
          // only place format + reserved-name rules can be enforced for that
          // path, so it is the one hook that covers EVERY write path.
          //
          // `.nullable()` matters: Better Auth's `parseInputData` skips the
          // validator only for `undefined`, so an explicit `username: null`
          // (OAuth signup creates the row before a handle is chosen) would
          // otherwise be rejected and break signup. `parseInputData` also keeps
          // `result.value`, so `usernameSchema`'s trim/lowercase transform
          // applies on this path too — which is what we want.
          validator: { input: usernameSchema.nullable() },
        },
        // Tracks whether the user has confirmed a username via onboarding. New
        // signups start with `false` and a null username; the onboarding flow
        // flips this to `true` once they pick one. Not client-settable — only
        // the server-side set-username endpoint updates it.
        usernameChosen: {
          type: "boolean",
          required: false,
          input: false,
          defaultValue: false,
        },
        // The user's GitHub login, set from the GitHub profile at signup. Used
        // only to suggest a username during onboarding. `username` itself is
        // never set at signup: a unique collision would break the signup.
        githubLogin: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    // Implicit linking joins multiple social identities that share a verified
    // email onto one account (e.g., a user who signs in with GitHub on one
    // visit and Google on the next). Safe because every provider in
    // trustedProviders returns a provider-verified email.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders,
      },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: appUrl ? `${appUrl}/cli-auth` : "/cli-auth",
        // Room for an OAuth signup plus choosing a username before approving.
        expiresIn: "15m",
        interval: getDeviceAuthInterval(),
        validateClient: (clientId) => clientId === cliClientId,
        schema: {},
      }),
      // Organizations are the tenancy/billing boundary that owns projects.
      // The plugin does not auto-create an org on signup, so we create a
      // "personal org" explicitly in the signup hook below.
      organization(),
      // Short-lived access JWTs for the CLI and worker, minted at
      // `GET /api/auth/token` with a session bearer and verified by the API.
      // Key rotation and token lifetime use the plugin defaults (no automatic
      // rotation, 15 minutes).
      jwt({
        jwks: { keyPairConfig: { alg: "EdDSA" } },
        jwt: {
          issuer: baseURL,
          audience: ACCESS_JWT_AUDIENCE,
          definePayload: ({ user }) => toAccessClaims(user),
        },
        disableSettingJwtHeader: true,
      }),
    ],
    advanced: {
      database: {
        generateId: () => createAuthId(),
      },
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
        : {}),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // Serve the session from a signed cookie snapshot instead of re-reading
      // it per request. Every `/api/*` route derives `auth` through
      // `createAuthenticated`, which costs a session + user SELECT; pages fire
      // four to six API calls in parallel, so this removes 8-12 database round
      // trips per page load.
      //
      // Staleness window: a snapshot lives for `maxAge` and is only rewritten
      // by Better Auth's own endpoints. Every write to `username` /
      // `usernameChosen` goes through one of them — `POST /username` delegates
      // to `auth.api.updateUser` and forwards the `Set-Cookie` headers it
      // returns — so the snapshot is re-signed in the same response that
      // changes the row and those two fields cannot lag behind it.
      //
      // Session revocation IS still delayed by up to `maxAge` on API routes;
      // sign-out clears the cookie outright, and nothing else revokes sessions
      // today.
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    databaseHooks: {
      user: {
        update: {
          // Derives `usernameChosen` server-side. The field stays `input: false`
          // (see `additionalFields` above) so no client can ever set it —
          // Better Auth's `parseInputData` rejects it with FIELD_NOT_ALLOWED.
          // That restriction has to stay: a client that could send
          // `usernameChosen: true` while leaving `username` null would strand
          // itself in an infinite redirect loop between the protected layout
          // (redirects to onboarding when `!usernameChosen`) and the dashboard
          // page (redirects to onboarding when `username == null`).
          //
          // But any write that sets a non-empty username IS, by definition, the
          // user confirming one — so the server infers the flag here instead of
          // trusting the request body. Doing it as a database hook covers EVERY
          // update path through Better Auth (`auth.api.updateUser`, its
          // `POST /update-user` route, plugins) rather than a single endpoint.
          // Idempotent for renames, where the flag is already true.
          //
          // Returning `{ data }` merges into the pending update and returning
          // `undefined` leaves it untouched (see `updateWithHooks` in
          // better-auth). `data["username"]` is `unknown` (it reaches the hook
          // through the index signature, since `username` is an additional
          // field), so the `typeof` check both narrows it and filters out
          // null/absent/empty writes.
          before: (data) => {
            const username = data["username"];

            return Promise.resolve(
              typeof username === "string" && username.length > 0
                ? { data: { ...data, usernameChosen: true } }
                : undefined,
            );
          },
        },
      },
      account: {
        create: {
          // Fires once per persisted account row. Account-linking creates a
          // second row for the same userId, so we guard on "first account ever"
          // to distinguish a real signup from a link.
          after: async (account) => {
            const db = getDb();
            const [accountCount] = await db
              .select({ value: count() })
              .from(authAccounts)
              .where(eq(authAccounts.userId, account.userId));
            if (!accountCount || accountCount.value !== 1) return;

            const [user] = await db
              .select({
                name: authUsers.name,
                emailVerified: authUsers.emailVerified,
              })
              .from(authUsers)
              .where(eq(authUsers.id, account.userId))
              .limit(1);

            // Every new user gets exactly one personal org they own. Idempotent
            // so account-linking edge cases never produce a second personal org.
            await ensurePersonalOrganization(db, {
              userId: account.userId,
              userName: user?.name ?? null,
            });

            analyticsServer.captureSignup(account.userId, {
              provider: toSignupProvider(account.providerId),
              email_verified: Boolean(user?.emailVerified),
            });
          },
        },
      },
    },
  });
};

let identityAuthSingleton: ReturnType<typeof createIdentityAuth> | null = null;

export const getIdentityAuth = () => {
  if (!identityAuthSingleton) {
    identityAuthSingleton = createIdentityAuth();
  }

  return identityAuthSingleton;
};
export type IdentityAuth = ReturnType<typeof createIdentityAuth>;
