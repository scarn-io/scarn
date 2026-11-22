import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { projectPermissionSchema } from "../domain/project-permission";
import { projectRoleSchema } from "../domain/project-role";
import { projectGitUrlSchema } from "../domain/project-git-url";
import { projectSlugSchema } from "../domain/project-slug";
import { projectVisibilitySchema } from "../domain/project-visibility";

export const projectMembershipSchema = z.object({
  userId: uuidV7Schema,
  role: z.string(),
  permissions: z.array(projectPermissionSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const projectSchema = z.object({
  id: uuidV7Schema,
  name: z.string().trim().min(1),
  slug: projectSlugSchema,
  description: z.string().trim().min(1).nullable(),
  gitUrl: projectGitUrlSchema,
  createdByUserId: uuidV7Schema,
  orgId: uuidV7Schema,
  // Read-time username of the project's OWNER (the owning org's owner user),
  // resolved from ids at read time and never persisted on the project row. Used
  // to build `/{ownerUsername}/{slug}` links and the owner breadcrumb so a
  // viewer looking at someone else's shared project links to the OWNER's URL,
  // not their own. `null` when the owner has no resolvable username.
  ownerUsername: z.string().trim().min(1).nullable(),
  memberships: z.array(projectMembershipSchema),
  // `private` by default. There is no HTTP route that sets this to `public`
  // — see `createProjectInputSchema` below, which omits it entirely — it is
  // only ever set by internal tooling (e.g. the demo-project seed script).
  visibility: projectVisibilitySchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const projectCreationOriginSchema = z.enum([
  "web",
  "cli_handoff",
  "cli_api",
]);

/**
 * Where the project's repo lives: `github` for a github.com URL, `manual` for
 * any other git URL. Derived from `gitUrl` by `setUpProject`, never sent by
 * the client.
 */
export type ProjectCreationSource = "github" | "bitbucket" | "manual";

export const createProjectInputSchema = projectSchema
  .omit({
    id: true,
    // Slug is derived from `name` server-side (slugify + de-dup within org),
    // never client-supplied.
    slug: true,
    createdByUserId: true,
    // Owning org is derived from the authenticated actor, never client-supplied.
    orgId: true,
    // Owner username is a read-time-resolved display field, never client-supplied.
    ownerUsername: true,
    memberships: true,
    // Never client-supplied: every API-created project starts private. Public
    // visibility is only ever set by internal tooling (see `createProject`'s
    // `visibility` dependency), never through this HTTP-facing input.
    visibility: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    // Which onboarding surface created the project; absent means "web".
    // Funnel attribution only (reported on `project_created`), never persisted.
    origin: projectCreationOriginSchema.optional(),
  });

export const getProjectInputSchema = uuidV7Schema;

export const updateProjectMembershipInputSchema = z.object({
  projectId: uuidV7Schema,
  userId: uuidV7Schema,
  role: projectRoleSchema,
});

export const updateProjectMemberRoleBodySchema =
  updateProjectMembershipInputSchema.pick({ role: true });

/**
 * A project member with read-time display fields, for member pickers and the
 * collaborators list.
 */
export const projectMemberSchema = z.object({
  userId: uuidV7Schema,
  username: z.string().nullable(),
  image: z.string().nullable(),
  role: z.string(),
  permissions: z.array(projectPermissionSchema),
});

export type ProjectMembershipContract = z.infer<typeof projectMembershipSchema>;
export type ProjectContract = z.infer<typeof projectSchema>;
export type ProjectMemberContract = z.infer<typeof projectMemberSchema>;
export type CreateProjectInput = z.input<typeof createProjectInputSchema>;
export type ProjectCreationOrigin = z.infer<typeof projectCreationOriginSchema>;
export type GetProjectInput = z.input<typeof getProjectInputSchema>;
export type UpdateProjectMembershipInput = z.input<
  typeof updateProjectMembershipInputSchema
>;
