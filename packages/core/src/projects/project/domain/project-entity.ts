import { createUuidV7, parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { parseProjectGitUrl } from "./project-git-url";
import { parseProjectSlug, type ProjectSlug } from "./project-slug";
import { ProjectMembership, type ProjectMembershipProps } from "./project-membership";
import {
  parseProjectVisibility,
  type ProjectVisibility,
} from "./project-visibility";

export type ProjectEntityProps = {
  id: UuidV7;
  name: string;
  slug: string;
  description?: string | null | undefined;
  gitUrl: string;
  createdByUserId: UuidV7;
  orgId: UuidV7;
  memberships: readonly ProjectMembershipProps[];
  // `private` when omitted/null. Only ever set to `public` internally (e.g.
  // the demo-project seed script) — there is no HTTP route that toggles it.
  visibility?: ProjectVisibility | null | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateProjectProps = Omit<
  ProjectEntityProps,
  "id"
> & {
  id?: UuidV7 | undefined;
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
      `Invalid project date value: ${String(value)}`,
      "INVALID_PROJECT_DATE",
    );
  }

  return parsed;
};

export class ProjectEntity {
  public readonly id: UuidV7;
  public readonly name: string;
  public readonly slug: ProjectSlug;
  public readonly description: string | null;
  public readonly gitUrl: string;
  public readonly createdByUserId: UuidV7;
  public readonly orgId: UuidV7;
  public readonly memberships: ProjectMembership[];
  public readonly visibility: ProjectVisibility;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: ProjectEntityProps) {
    const name = props.name.trim();
    if (!name) {
      throw new CoreValidationError(
        "Project name is required",
        "PROJECT_NAME_REQUIRED",
      );
    }

    const memberships = props.memberships.map((membership) =>
      ProjectMembership.rehydrate(membership),
    );

    this.id = parseUuidV7(props.id);
    this.name = name;
    this.slug = parseProjectSlug(props.slug);
    this.description = props.description?.trim() || null;
    this.gitUrl = parseProjectGitUrl(props.gitUrl);
    this.createdByUserId = parseUuidV7(props.createdByUserId);
    this.orgId = parseUuidV7(props.orgId);
    this.memberships = memberships;
    this.visibility = parseProjectVisibility(props.visibility);
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  static create(props: CreateProjectProps): ProjectEntity {
    return new ProjectEntity({
      ...props,
      id: props.id ?? createUuidV7(),
    });
  }

  static rehydrate(props: ProjectEntityProps): ProjectEntity {
    return new ProjectEntity(props);
  }

  getMembership(userId: UuidV7): ProjectMembership | null {
    return this.memberships.find((membership) => membership.userId === userId) ?? null;
  }

  withMembership(
    membership: ProjectMembership,
    updatedAt: Date,
  ): ProjectEntity {
    const otherMemberships = this.memberships.filter(
      (existingMembership) => existingMembership.userId !== membership.userId,
    );

    return new ProjectEntity({
      ...this.toJSON(),
      memberships: [...otherMemberships, membership]
        .sort((left, right) => left.userId.localeCompare(right.userId))
        .map((item) => item.toJSON()),
      updatedAt,
    });
  }

  withVisibility(visibility: ProjectVisibility, updatedAt: Date): ProjectEntity {
    return new ProjectEntity({
      ...this.toJSON(),
      visibility,
      updatedAt,
    });
  }

  toJSON(): ProjectEntityProps {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      description: this.description,
      gitUrl: this.gitUrl,
      createdByUserId: this.createdByUserId,
      orgId: this.orgId,
      memberships: this.memberships.map((membership) => membership.toJSON()),
      visibility: this.visibility,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
