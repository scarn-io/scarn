import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  OrganizationMember,
  type OrganizationMemberProps,
} from "./organization-member";

export type OrganizationEntityProps = {
  id: UuidV7;
  name: string;
  slug: string;
  isPersonal: boolean;
  ownerUserId?: UuidV7 | null | undefined;
  members: readonly OrganizationMemberProps[];
  createdAt?: Date | string | null | undefined;
};

export type CreatePersonalOrganizationProps = {
  id?: UuidV7 | undefined;
  name: string;
  slug: string;
  ownerUserId: UuidV7;
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
      `Invalid organization date value: ${String(value)}`,
      "INVALID_ORGANIZATION_DATE",
    );
  }

  return parsed;
};

export class OrganizationEntity {
  public readonly id: UuidV7;
  public readonly name: string;
  public readonly slug: string;
  public readonly isPersonal: boolean;
  public readonly ownerUserId: UuidV7 | null;
  public readonly members: OrganizationMember[];
  public readonly createdAt: Date | null | undefined;

  private constructor(props: OrganizationEntityProps) {
    const name = props.name.trim();
    if (!name) {
      throw new CoreValidationError(
        "Organization name is required",
        "ORGANIZATION_NAME_REQUIRED",
      );
    }

    const slug = props.slug.trim();
    if (!slug) {
      throw new CoreValidationError(
        "Organization slug is required",
        "ORGANIZATION_SLUG_REQUIRED",
      );
    }

    const members = props.members.map((member) =>
      OrganizationMember.rehydrate(member),
    );

    if (props.isPersonal && !members.some((member) => member.isOwner())) {
      throw new CoreValidationError(
        "A personal organization must have an owner member",
        "ORGANIZATION_PERSONAL_OWNER_REQUIRED",
      );
    }

    this.id = parseUuidV7(props.id);
    this.name = name;
    this.slug = slug;
    this.isPersonal = props.isPersonal;
    this.ownerUserId = props.ownerUserId
      ? parseUuidV7(props.ownerUserId)
      : null;
    this.members = members;
    this.createdAt = normalizeDate(props.createdAt);
  }

  static createPersonal(
    props: CreatePersonalOrganizationProps,
  ): OrganizationEntity {
    return new OrganizationEntity({
      id: props.id ?? createUuidV7(),
      name: props.name,
      slug: props.slug,
      isPersonal: true,
      ownerUserId: props.ownerUserId,
      members: [
        {
          userId: props.ownerUserId,
          role: "owner",
          createdAt: props.createdAt,
        },
      ],
      createdAt: props.createdAt,
    });
  }

  static rehydrate(props: OrganizationEntityProps): OrganizationEntity {
    return new OrganizationEntity(props);
  }

  getMember(userId: UuidV7): OrganizationMember | null {
    return (
      this.members.find((member) => member.userId === userId) ?? null
    );
  }

  toJSON(): OrganizationEntityProps {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      isPersonal: this.isPersonal,
      ownerUserId: this.ownerUserId,
      members: this.members.map((member) => member.toJSON()),
      createdAt: this.createdAt,
    };
  }
}
