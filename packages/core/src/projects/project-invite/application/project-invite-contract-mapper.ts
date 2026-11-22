import {
  projectInviteSchema,
  type ProjectInviteContract,
} from "../contracts/project-invite-contracts";
import type { ProjectInviteEntity } from "../domain/project-invite-entity";

export const projectInviteEntityToContract = (
  invite: ProjectInviteEntity,
): ProjectInviteContract =>
  projectInviteSchema.parse({
    id: invite.id,
    projectId: invite.projectId,
    email: invite.email,
    role: invite.role,
    restriction: invite.restriction,
    permissions: [...invite.permissions],
    invitedByUserId: invite.invitedByUserId,
    status: invite.status,
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
  });
