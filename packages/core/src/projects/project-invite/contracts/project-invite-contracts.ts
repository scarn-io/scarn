import { z } from "zod";
import { projectRoleSchema } from "@scarn/core/projects/project/domain/project-role";

export const projectInviteRoleSchema = projectRoleSchema;
export const projectInviteStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export const projectInviteRestrictionSchema = z.enum([
  "specific_email",
  "any_authenticated_user",
]);

export const projectInviteSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  email: z.string().nullable(),
  role: projectInviteRoleSchema,
  restriction: projectInviteRestrictionSchema,
  permissions: z.array(z.string()),
  invitedByUserId: z.string(),
  status: projectInviteStatusSchema,
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectInviteContract = z.infer<typeof projectInviteSchema>;

export const createProjectInviteInputSchema = z
  .object({
    email: z.email().optional(),
    role: projectInviteRoleSchema,
    restriction: projectInviteRestrictionSchema,
  })
  .superRefine((value, ctx) => {
    if (value.restriction === "specific_email" && !value.email) {
      ctx.addIssue({
        code: "custom",
        message:
          "Email is required when restricting an invite to a specific email",
        path: ["email"],
      });
    }

    if (value.restriction === "any_authenticated_user" && value.email) {
      ctx.addIssue({
        code: "custom",
        message: "Email must be omitted for unrestricted invite links",
        path: ["email"],
      });
    }
  });

export type CreateProjectInviteInput = z.infer<
  typeof createProjectInviteInputSchema
>;

export const publicInviteDetailsSchema = z.object({
  inviteId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  // Read-time fields for building the project's pretty URL
  // `/{ownerUsername}/{projectSlug}` after acceptance. `ownerUsername` is null
  // when the owner has no resolvable username; the UI falls back to `/`.
  projectSlug: z.string(),
  ownerUsername: z.string().nullable(),
  role: projectInviteRoleSchema,
  restriction: projectInviteRestrictionSchema,
  permissions: z.array(z.string()),
  status: projectInviteStatusSchema,
  expiresAt: z.string(),
});

export type PublicInviteDetails = z.infer<typeof publicInviteDetailsSchema>;
