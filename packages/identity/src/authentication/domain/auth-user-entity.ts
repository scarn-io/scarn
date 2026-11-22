import { type AuthId, parseAuthId } from "./auth-id";
import { normalizeDate } from "./date-utils";

export class AuthUserEntity {
  public readonly id: AuthId;
  public image: string | null;
  public createdAt: Date | null;
  public updatedAt: Date | null;

  constructor(
    id: string,
    public readonly email: string,
    public readonly username: string | null,
    public readonly name: string,
    public readonly emailVerified: boolean,
    public readonly usernameChosen: boolean = false,
    image?: string | null,
    createdAt?: Date | string | null,
    updatedAt?: Date | string | null,
  ) {
    this.id = parseAuthId(id);
    this.image = image ?? null;
    this.createdAt = normalizeDate(createdAt);
    this.updatedAt = normalizeDate(updatedAt);
  }
}
