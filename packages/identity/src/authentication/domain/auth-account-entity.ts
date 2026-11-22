import { type AuthId, parseAuthId } from "./auth-id";
import { normalizeDate } from "./date-utils";

export class AuthAccountEntity {
  public readonly id: AuthId;
  public readonly userId: AuthId;
  public accessToken: string | null;
  public refreshToken: string | null;
  public idToken: string | null;
  public accessTokenExpiresAt: Date | null;
  public refreshTokenExpiresAt: Date | null;
  public scope: string | null;
  public createdAt: Date | null;
  public updatedAt: Date | null;

  constructor(
    id: string,
    public readonly accountId: string,
    public readonly providerId: string,
    userId: string,
    accessToken?: string | null,
    refreshToken?: string | null,
    idToken?: string | null,
    accessTokenExpiresAt?: Date | string | null,
    refreshTokenExpiresAt?: Date | string | null,
    scope?: string | null,
    createdAt?: Date | string | null,
    updatedAt?: Date | string | null,
  ) {
    this.id = parseAuthId(id);
    this.userId = parseAuthId(userId);
    this.accessToken = accessToken ?? null;
    this.refreshToken = refreshToken ?? null;
    this.idToken = idToken ?? null;
    this.accessTokenExpiresAt = normalizeDate(accessTokenExpiresAt);
    this.refreshTokenExpiresAt = normalizeDate(refreshTokenExpiresAt);
    this.scope = scope ?? null;
    this.createdAt = normalizeDate(createdAt);
    this.updatedAt = normalizeDate(updatedAt);
  }
}
