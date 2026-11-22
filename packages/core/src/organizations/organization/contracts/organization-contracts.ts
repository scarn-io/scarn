import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";

export const organizationMemberRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
]);

export const organizationMemberSchema = z.object({
  userId: uuidV7Schema,
  role: organizationMemberRoleSchema,
  createdAt: z.iso.datetime(),
});

export const organizationSchema = z.object({
  id: uuidV7Schema,
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  isPersonal: z.boolean(),
  ownerUserId: uuidV7Schema.nullable(),
  members: z.array(organizationMemberSchema),
  createdAt: z.iso.datetime(),
});

export const createPersonalOrganizationInputSchema = z.object({
  ownerUserId: uuidV7Schema,
  ownerName: z.string().trim().min(1).nullable(),
});

export type OrganizationMemberRole = z.infer<
  typeof organizationMemberRoleSchema
>;
export type OrganizationMemberContract = z.infer<
  typeof organizationMemberSchema
>;
export type OrganizationContract = z.infer<typeof organizationSchema>;
export type CreatePersonalOrganizationInput = z.input<
  typeof createPersonalOrganizationInputSchema
>;
