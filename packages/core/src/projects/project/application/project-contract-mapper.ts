import {
  projectMembershipSchema,
  projectSchema,
  type ProjectContract,
  type ProjectMembershipContract,
} from "../contracts/project-contracts";
import type { ProjectEntity } from "../domain/project-entity";
import type { ProjectMembership } from "../domain/project-membership";

const toMembershipFields = (membership: ProjectMembership) => ({
  userId: membership.userId,
  role: membership.role,
  permissions: membership.permissions,
  createdAt: membership.createdAt?.toISOString() ?? null,
  updatedAt: membership.updatedAt?.toISOString() ?? null,
});

export const projectMembershipToContract = (
  membership: ProjectMembership,
): ProjectMembershipContract =>
  projectMembershipSchema.parse(toMembershipFields(membership));

export const projectEntityToContract = (
  project: ProjectEntity,
  ownerUsername: string | null = null,
): ProjectContract =>
  projectSchema.parse({
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    gitUrl: project.gitUrl,
    createdByUserId: project.createdByUserId,
    orgId: project.orgId,
    ownerUsername,
    memberships: project.memberships.map(toMembershipFields),
    visibility: project.visibility,
    createdAt: project.createdAt?.toISOString() ?? null,
    updatedAt: project.updatedAt?.toISOString() ?? null,
  });
