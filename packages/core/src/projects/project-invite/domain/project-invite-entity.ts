import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import {
  permissionsForRole,
  type ProjectRole,
} from "@scarn/core/projects/project/domain/project-role";
import type { ProjectInviteRestriction } from "./project-invite-restriction";
import type { ProjectInviteStatus } from "./project-invite-status";

export type ProjectInviteProps = {
  id: UuidV7;
  projectId: UuidV7;
  email: string | null;
  role: ProjectRole;
  restriction: ProjectInviteRestriction;
  tokenHash: string;
  invitedByUserId: UuidV7;
  status: ProjectInviteStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: UuidV7 | null;
  createdAt: Date;
  updatedAt: Date;
};

export class ProjectInviteEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly email: string | null;
  public readonly role: ProjectRole;
  public readonly restriction: ProjectInviteRestriction;
  public readonly tokenHash: string;
  public readonly invitedByUserId: UuidV7;
  public readonly status: ProjectInviteStatus;
  public readonly expiresAt: Date;
  public readonly acceptedAt: Date | null;
  public readonly acceptedByUserId: UuidV7 | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: ProjectInviteProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.email = props.email;
    this.role = props.role;
    this.restriction = props.restriction;
    this.tokenHash = props.tokenHash;
    this.invitedByUserId = props.invitedByUserId;
    this.status = props.status;
    this.expiresAt = props.expiresAt;
    this.acceptedAt = props.acceptedAt;
    this.acceptedByUserId = props.acceptedByUserId;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(props: ProjectInviteProps): ProjectInviteEntity {
    return new ProjectInviteEntity(props);
  }

  static rehydrate(props: ProjectInviteProps): ProjectInviteEntity {
    return new ProjectInviteEntity(props);
  }

  /** Permissions the invitee will get from the invite's role. */
  get permissions(): readonly ProjectPermission[] {
    return permissionsForRole(this.role);
  }

  isExpired(): boolean {
    return this.expiresAt < new Date();
  }

  isPending(): boolean {
    return this.status === "pending";
  }

  toJSON(): ProjectInviteProps {
    return {
      id: this.id,
      projectId: this.projectId,
      email: this.email,
      role: this.role,
      restriction: this.restriction,
      tokenHash: this.tokenHash,
      invitedByUserId: this.invitedByUserId,
      status: this.status,
      expiresAt: this.expiresAt,
      acceptedAt: this.acceptedAt,
      acceptedByUserId: this.acceptedByUserId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
