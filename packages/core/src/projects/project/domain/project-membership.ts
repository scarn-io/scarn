import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectPermission } from "./project-permission";
import { permissionsForRole } from "./project-role";

export type ProjectMembershipProps = {
  projectId: UuidV7;
  userId: UuidV7;
  role: string;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
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

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export class ProjectMembership {
  public readonly projectId: UuidV7;
  public readonly userId: UuidV7;
  public readonly role: string;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: ProjectMembershipProps) {
    this.projectId = parseUuidV7(props.projectId);
    this.userId = parseUuidV7(props.userId);
    this.role = props.role;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  static create(props: ProjectMembershipProps): ProjectMembership {
    return new ProjectMembership(props);
  }

  static rehydrate(props: ProjectMembershipProps): ProjectMembership {
    return new ProjectMembership(props);
  }

  /** Permissions resolved from the role; an unknown role grants none. */
  get permissions(): readonly ProjectPermission[] {
    return permissionsForRole(this.role);
  }

  withRole(role: string, updatedAt: Date): ProjectMembership {
    return new ProjectMembership({
      ...this.toJSON(),
      role,
      updatedAt,
    });
  }

  toJSON(): ProjectMembershipProps {
    return {
      projectId: this.projectId,
      userId: this.userId,
      role: this.role,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
