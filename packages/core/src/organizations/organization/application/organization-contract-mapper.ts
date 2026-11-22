import type { OrganizationEntity } from "../domain/organization-entity";
import {
  organizationSchema,
  type OrganizationContract,
} from "../contracts/organization-contracts";

const toIsoString = (value: Date | null | undefined): string =>
  (value ?? new Date()).toISOString();

export const organizationEntityToContract = (
  organization: OrganizationEntity,
): OrganizationContract =>
  organizationSchema.parse({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    isPersonal: organization.isPersonal,
    ownerUserId: organization.ownerUserId,
    members: organization.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      createdAt: toIsoString(member.createdAt),
    })),
    createdAt: toIsoString(organization.createdAt),
  });
