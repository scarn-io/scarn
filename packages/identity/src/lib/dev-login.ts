import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { createAuthId } from "../authentication/domain/auth-id";
import { AuthAccountEntity } from "../authentication/domain/auth-account-entity";
import { AuthSessionEntity } from "../authentication/domain/auth-session-entity";
import { AuthUserEntity } from "../authentication/domain/auth-user-entity";
import { DrizzleAuthAccountRepo } from "../authentication/infra/drizzle-auth-account-repo";
import { DrizzleAuthSessionRepo } from "../authentication/infra/drizzle-auth-session-repo";
import { DrizzleAuthUserRepo } from "../authentication/infra/drizzle-auth-user-repo";
import { getIdentityAuth } from "./auth";
import { getBetterAuthSecret, getDevLoginEnabled } from "./env";

export const DEV_LOGIN_DEFAULT_EMAIL = "dev@scarn.local";
const DEV_SEED_PROVIDER_ID = "dev";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// RFC-5322 is wildly more complex than this; for dev impersonation we just want
// to reject obvious garbage before touching the DB.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export type DevLoginCookie = {
  name: string;
  value: string;
  path: string;
  domain: string | undefined;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  maxAge: number;
};

const normalizeSameSite = (
  value: string | undefined,
): "Strict" | "Lax" | "None" => {
  if (typeof value !== "string") return "Lax";
  const lower = value.toLowerCase();
  if (lower === "strict") return "Strict";
  if (lower === "none") return "None";
  return "Lax";
};

export class DevLoginInvalidEmailError extends Error {
  constructor(public readonly email: string) {
    super(`Invalid email for dev login: ${email}`);
    this.name = "DevLoginInvalidEmailError";
  }
}

// Opens a session as the user with the given email (creating the user record
// on the fly if it doesn't exist yet) and returns the signed cookie payload
// the caller should set on the response. This is the impersonation hook for
// local development — pass any email to log in as that user.
//
// Throws when dev login is disabled — callers should already have checked, but
// this is the last line of defence against ever issuing a dev session in prod.
export const createDevLoginSession = async (
  rawEmail: string = DEV_LOGIN_DEFAULT_EMAIL,
): Promise<DevLoginCookie> => {
  if (!getDevLoginEnabled()) {
    throw new Error("Dev login is disabled");
  }

  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new DevLoginInvalidEmailError(rawEmail);
  }

  const userRepo = new DrizzleAuthUserRepo();
  const accountRepo = new DrizzleAuthAccountRepo();
  const sessionRepo = new DrizzleAuthSessionRepo();

  let user = await userRepo.loadByEmail(email);
  if (!user) {
    // Dev users go through the same "choose your username" onboarding as
    // everyone else: create the row with a null username and usernameChosen
    // false so the onboarding redirect fires on first login. The display name
    // is a non-PII placeholder constant — nothing is derived from the email
    // local part (the PII fix). The user picks a real handle in onboarding.
    user = await userRepo.save(
      new AuthUserEntity(
        createAuthId(),
        email,
        null,
        "New user",
        true,
        false,
      ),
    );
  }

  const existingAccount = await accountRepo.loadByProviderAccount(
    DEV_SEED_PROVIDER_ID,
    email,
  );
  if (!existingAccount) {
    await accountRepo.save(
      new AuthAccountEntity(
        createAuthId(),
        email,
        DEV_SEED_PROVIDER_ID,
        user.id,
      ),
    );
  }

  // Mirrors better-auth's session token shape — raw bytes hex-encoded, stored
  // verbatim in authSessions.token. The cookie value is `${token}.${HMAC}` so
  // better-auth's normal cookie reader verifies the signature and then looks
  // the raw token up directly.
  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await sessionRepo.save(
    new AuthSessionEntity(createAuthId(), user.id, sessionToken, expiresAt),
  );

  const signature = await makeSignature(sessionToken, getBetterAuthSecret());
  const signedValue = `${sessionToken}.${signature}`;

  const authContext = await getIdentityAuth().$context;
  const cookieMeta = authContext.authCookies.sessionToken;

  return {
    name: cookieMeta.name,
    value: signedValue,
    path: cookieMeta.attributes.path ?? "/",
    domain: cookieMeta.attributes.domain,
    httpOnly: cookieMeta.attributes.httpOnly ?? true,
    secure: cookieMeta.attributes.secure ?? false,
    sameSite: normalizeSameSite(cookieMeta.attributes.sameSite),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
};
