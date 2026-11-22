import type { TimeString } from "better-auth/plugins";

const getRequiredTrimmedEnv = (...keys: readonly string[]): string => {
  for (const key of keys) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  throw new Error(
    `Missing required environment variable. Tried: ${keys.join(", ")}`,
  );
};

const getOptionalTrimmedEnv = (...keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return null;
};

export const getDatabaseUrl = (): string =>
  getRequiredTrimmedEnv("DATABASE_URL");

export const getBetterAuthSecret = (): string =>
  getRequiredTrimmedEnv("BETTER_AUTH_SECRET");

export const getBetterAuthBaseUrl = (): string =>
  getRequiredTrimmedEnv("BETTER_AUTH_URL");

export const getBetterAuthTrustedOrigins = (): string[] => {
  const rawOrigins = getOptionalTrimmedEnv("BETTER_AUTH_TRUSTED_ORIGINS");

  if (!rawOrigins) {
    return [];
  }

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
};

/**
 * The domain session cookies are shared across (e.g. `example.com` so both
 * `app.` and `api.` subdomains see them); null keeps host-only cookies.
 */
export const getBetterAuthCookieDomain = (): string | null =>
  getOptionalTrimmedEnv("BETTER_AUTH_COOKIE_DOMAIN");

/** The app's public URL without a trailing slash; null when `APP_URL` is unset. */
export const getAppUrl = (): string | null =>
  getOptionalTrimmedEnv("APP_URL")?.replace(/\/+$/u, "") || null;

export const getIdentityAppName = (): string =>
  getOptionalTrimmedEnv("BETTER_AUTH_APP_NAME") ?? "Scarn";

export const getDeviceAuthInterval = (): TimeString =>
  (getOptionalTrimmedEnv("DEVICE_AUTH_INTERVAL") ?? "5s") as TimeString;

export const getPosthogServerKey = (): string | null =>
  getOptionalTrimmedEnv("POSTHOG_API_KEY");

export const getPosthogServerHost = (): string | null =>
  getOptionalTrimmedEnv("POSTHOG_HOST");

export type GitHubAppConfig = {
  appId: string;
  appSlug: string;
  privateKey: string | null;
};

const normalizePrivateKey = (value: string): string =>
  value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;

export const getGitHubAppConfig = (): GitHubAppConfig | null => {
  const appId = getOptionalTrimmedEnv("GITHUB_APP_ID");
  const appSlug = getOptionalTrimmedEnv("GITHUB_APP_SLUG");

  if (!appId || !appSlug) {
    return null;
  }

  const rawPrivateKey = getOptionalTrimmedEnv("GITHUB_APP_PRIVATE_KEY");

  return {
    appId,
    appSlug,
    privateKey: rawPrivateKey ? normalizePrivateKey(rawPrivateKey) : null,
  };
};

export const getGitHubAppWebhookSecret = (): string | null =>
  getOptionalTrimmedEnv("GITHUB_APP_WEBHOOK_SECRET");

export type GitHubAppOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

export const getGitHubAppOAuthConfig = (): GitHubAppOAuthConfig | null => {
  const clientId = getOptionalTrimmedEnv("GITHUB_APP_CLIENT_ID");
  const clientSecret = getOptionalTrimmedEnv("GITHUB_APP_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
};

export type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

export const getGoogleOAuthConfig = (): GoogleOAuthConfig | null => {
  const clientId = getOptionalTrimmedEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = getOptionalTrimmedEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
};

/**
 * Email/password sign-in and sign-up through Better Auth. On unless
 * `ENABLE_EMAIL_PASSWORD_LOGIN` is `false` or `0`, so a self-hosted install can
 * sign in without any OAuth provider; the cloud turns it off. There is no mail
 * transport, so addresses are not verified.
 */
export const getEmailPasswordLoginEnabled = (): boolean => {
  const raw = getOptionalTrimmedEnv(
    "ENABLE_EMAIL_PASSWORD_LOGIN",
  )?.toLowerCase();
  return raw !== "false" && raw !== "0";
};

// "Sign in as seed user" is gated on BOTH a non-production environment AND an
// explicit opt-in flag — defense in depth so a leaked env var alone can't
// unlock the dev endpoint against a prod database.
//
// We check VERCEL_ENV (not NODE_ENV) because Vercel sets NODE_ENV=production
// for *every* build including previews; VERCEL_ENV is the only signal that
// distinguishes a real production deploy from a preview deploy, and we want
// dev login to remain available on previews. For non-Vercel environments
// (e.g. a contributor's laptop) VERCEL_ENV is undefined and this check passes.
//
// The dev-login route is *also* stripped from the production bundle at build
// time (see apps/next/next.config.ts + apps/next/app/api/dev/login/route.ts),
// so this runtime check is the second of two independent gates.
export const getDevLoginEnabled = (): boolean => {
  if (process.env["VERCEL_ENV"] === "production") {
    return false;
  }

  return getOptionalTrimmedEnv("ENABLE_DEV_LOGIN") === "true";
};
