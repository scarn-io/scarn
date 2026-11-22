import { type AuthId, parseAuthId } from "./auth-id";
import { normalizeDate } from "./date-utils";

export class AuthVerificationEntity {
  public readonly id: AuthId;
  public expiresAt: Date;
  public createdAt: Date | null;
  public updatedAt: Date | null;

  constructor(
    id: string,
    public readonly identifier: string,
    public readonly value: string,
    expiresAt: Date | string,
    createdAt?: Date | string | null,
    updatedAt?: Date | string | null,
  ) {
    this.id = parseAuthId(id);

    const normalizedExpiresAt = normalizeDate(expiresAt);

    if (!normalizedExpiresAt) {
      throw new Error("Verification expiresAt is required");
    }

    this.expiresAt = normalizedExpiresAt;
    this.createdAt = normalizeDate(createdAt);
    this.updatedAt = normalizeDate(updatedAt);
  }

  isExpired(at: Date = new Date()): boolean {
    return this.expiresAt.getTime() <= at.getTime();
  }
}
