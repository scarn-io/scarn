import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  organizationMemberRoleSchema,
  type OrganizationMemberRole,
} from "../contracts/organization-contracts";

export type OrganizationMemberProps = {
  userId: UuidV7;
  role: OrganizationMemberRole;
  createdAt?: Date | string | null | undefined;
};

const normalizeDate = (
  value?: Date | string | null,
): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CoreValidationError(
      `Invalid organization member date value: ${String(value)}`,
      "INVALID_ORGANIZATION_MEMBER_DATE",
    );
  }

  return parsed;
};

export class OrganizationMember {
  public readonly userId: UuidV7;
  public readonly role: OrganizationMemberRole;
  public readonly createdAt: Date | null | undefined;

  private constructor(props: OrganizationMemberProps) {
    this.userId = parseUuidV7(props.userId);
    this.role = organizationMemberRoleSchema.parse(props.role);
    this.createdAt = normalizeDate(props.createdAt);
  }

  static create(props: OrganizationMemberProps): OrganizationMember {
    return new OrganizationMember(props);
  }

  static rehydrate(props: OrganizationMemberProps): OrganizationMember {
    return new OrganizationMember(props);
  }

  isOwner(): boolean {
    return this.role === "owner";
  }

  toJSON(): OrganizationMemberProps {
    return {
      userId: this.userId,
      role: this.role,
      createdAt: this.createdAt,
    };
  }
}
