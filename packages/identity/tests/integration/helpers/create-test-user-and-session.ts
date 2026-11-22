import { randomBytes, randomUUID } from "node:crypto";
import { createAuthId } from "../../../src/authentication/domain/auth-id";
import { AuthAccountEntity } from "../../../src/authentication/domain/auth-account-entity";
import { AuthSessionEntity } from "../../../src/authentication/domain/auth-session-entity";
import { AuthUserEntity } from "../../../src/authentication/domain/auth-user-entity";
import { DrizzleAuthAccountRepo } from "../../../src/authentication/infra/drizzle-auth-account-repo";
import { DrizzleAuthSessionRepo } from "../../../src/authentication/infra/drizzle-auth-session-repo";
import { DrizzleAuthUserRepo } from "../../../src/authentication/infra/drizzle-auth-user-repo";

export type TestUserOverrides = {
  email?: string;
  // Pass `null` to create an un-onboarded user (null username, usernameChosen
  // false). Omit for a deterministic, schema-valid unique default.
  username?: string | null;
  name?: string;
  image?: string | null;
  providerId?: "github" | "google";
  accountId?: string;
  expiresAt?: Date;
};

export type TestUserAndSession = {
  userId: string;
  sessionToken: string;
  authHeaders: { authorization: string };
};

export const createTestUserAndSession = async (
  overrides: TestUserOverrides = {},
): Promise<TestUserAndSession> => {
  const userId = createAuthId();
  const email = overrides.email ?? `test-${randomUUID()}@example.com`;
  // Distinguish "not provided" (deterministic unique default) from an explicit
  // `null` (un-onboarded user), which `??` would otherwise collapse together.
  const username =
    "username" in overrides
      ? (overrides.username ?? null)
      : `user-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // A null username means the user hasn't completed onboarding yet.
  const usernameChosen = username !== null;
  const name = overrides.name ?? "Test User";
  const providerId = overrides.providerId ?? "github";
  const accountId = overrides.accountId ?? `${providerId}-${userId}`;
  const expiresAt =
    overrides.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // Mirrors Better Auth's `generateId(32)` shape: a raw token with no `.`, so
  // the bearer plugin takes the no-dot branch and HMAC-signs it before
  // looking it up in `authSessions.token`.
  const sessionToken = randomBytes(32).toString("hex");

  await new DrizzleAuthUserRepo().save(
    new AuthUserEntity(
      userId,
      email,
      username,
      name,
      true,
      usernameChosen,
      overrides.image ?? null,
    ),
  );

  await new DrizzleAuthAccountRepo().save(
    new AuthAccountEntity(createAuthId(), accountId, providerId, userId),
  );

  await new DrizzleAuthSessionRepo().save(
    new AuthSessionEntity(createAuthId(), userId, sessionToken, expiresAt),
  );

  return {
    userId,
    sessionToken,
    authHeaders: { authorization: `Bearer ${sessionToken}` },
  };
};
