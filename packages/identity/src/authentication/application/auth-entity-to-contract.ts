import type {
  AuthAccount,
  AuthSession,
  AuthSessionWithUser,
  AuthUser,
  AuthVerification,
} from "../contracts/auth-contracts";
import type { AuthAccountEntity } from "../domain/auth-account-entity";
import type { AuthSessionEntity } from "../domain/auth-session-entity";
import type { AuthUserEntity } from "../domain/auth-user-entity";
import type { AuthVerificationEntity } from "../domain/auth-verification-entity";

const toIsoString = (value: Date | null): string | null => value?.toISOString() ?? null;

export const authUserEntityToContract = (user: AuthUserEntity): AuthUser => ({
  id: user.id,
  email: user.email,
  username: user.username,
  name: user.name,
  emailVerified: user.emailVerified,
  usernameChosen: user.usernameChosen,
  image: user.image,
  createdAt: toIsoString(user.createdAt),
  updatedAt: toIsoString(user.updatedAt),
});

export const authSessionEntityToContract = (
  session: AuthSessionEntity,
): AuthSession => ({
  id: session.id,
  userId: session.userId,
  token: session.token,
  expiresAt: session.expiresAt.toISOString(),
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  createdAt: toIsoString(session.createdAt),
  updatedAt: toIsoString(session.updatedAt),
});

export const authAccountEntityToContract = (
  account: AuthAccountEntity,
): AuthAccount => ({
  id: account.id,
  accountId: account.accountId,
  providerId: account.providerId,
  userId: account.userId,
  accessToken: account.accessToken,
  refreshToken: account.refreshToken,
  idToken: account.idToken,
  accessTokenExpiresAt: toIsoString(account.accessTokenExpiresAt),
  refreshTokenExpiresAt: toIsoString(account.refreshTokenExpiresAt),
  scope: account.scope,
  createdAt: toIsoString(account.createdAt),
  updatedAt: toIsoString(account.updatedAt),
});

export const authVerificationEntityToContract = (
  verification: AuthVerificationEntity,
): AuthVerification => ({
  id: verification.id,
  identifier: verification.identifier,
  value: verification.value,
  expiresAt: verification.expiresAt.toISOString(),
  createdAt: toIsoString(verification.createdAt),
  updatedAt: toIsoString(verification.updatedAt),
});

export const authSessionWithUserEntityToContract = (
  session: AuthSessionEntity,
  user: AuthUserEntity,
): AuthSessionWithUser => ({
  session: authSessionEntityToContract(session),
  user: authUserEntityToContract(user),
});
