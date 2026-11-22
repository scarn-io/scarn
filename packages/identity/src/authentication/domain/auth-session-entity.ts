import { type AuthId, parseAuthId } from "./auth-id";
import { normalizeDate } from "./date-utils";

export class AuthSessionEntity {
  public readonly id: AuthId;
  public readonly userId: AuthId;
  public ipAddress: string | null;
  public userAgent: string | null;
  public createdAt: Date | null;
  public updatedAt: Date | null;
  public expiresAt: Date;

  constructor(
    id: string,
    userId: string,
    public readonly token: string,
    expiresAt: Date | string,
    ipAddress?: string | null,
    userAgent?: string | null,
    createdAt?: Date | string | null,
    updatedAt?: Date | string | null,
  ) {
    this.id = parseAuthId(id);
    this.userId = parseAuthId(userId);

    const normalizedExpiresAt = normalizeDate(expiresAt);

    if (!normalizedExpiresAt) {
      throw new Error("Session expiresAt is required");
    }

    this.expiresAt = normalizedExpiresAt;
    this.ipAddress = ipAddress ?? null;
    this.userAgent = userAgent ?? null;
    this.createdAt = normalizeDate(createdAt);
    this.updatedAt = normalizeDate(updatedAt);
  }

  isExpired(at: Date = new Date()): boolean {
    return this.expiresAt.getTime() <= at.getTime();
  }
}
