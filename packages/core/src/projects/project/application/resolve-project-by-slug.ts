import { z } from "zod";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import { projectEntityToContract } from "./project-contract-mapper";
import { assertProjectPermission } from "./project-authorization";
import type { ProjectRepo } from "./project-repo";
import { type ProjectContract } from "../contracts/project-contracts";

export const resolveProjectBySlugInputSchema = z.object({
  username: z.string().trim().min(1),
  projectSlug: z.string().trim().min(1),
});

export type ResolveProjectBySlugInput = z.input<
  typeof resolveProjectBySlugInputSchema
>;

/**
 * Resolve a pretty URL (`/{username}/{projectSlug}`) to a project.
 *
 * Chain: username → owner's personal org (slug `personal-<userId>`) → project by
 * `(orgId, slug)`. Any miss — unknown username, no personal org, unknown slug,
 * or a stale username after a rename — returns a `ResourceNotFoundError` (404),
 * matching the "hard 404, no redirects" decision. Membership is still enforced
 * so a valid pretty URL a user is not a member of surfaces the same 403 as the
 * UUID path.
 */
export const resolveProjectBySlug = async (
  input: ResolveProjectBySlugInput,
  {
    userAuthz,
    projectRepo,
    orgRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: ProjectRepo;
    orgRepo: OrgRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ProjectContract, ResourceNotFoundError>> => {
  const { username, projectSlug } =
    resolveProjectBySlugInputSchema.parse(input);

  const org = await orgRepo.loadPersonalOrgByOwnerUsername(
    username,
    dbExecutor,
  );
  if (!org) {
    return Result.err(
      new ResourceNotFoundError("Project", `${username}/${projectSlug}`),
    );
  }

  const project = await projectRepo.loadByOrgAndSlug(
    org.id,
    projectSlug,
    dbExecutor,
  );
  if (!project) {
    return Result.err(
      new ResourceNotFoundError("Project", `${username}/${projectSlug}`),
    );
  }

  assertProjectPermission(project, userAuthz.actorId, "work-items:read");

  // The owner username is exactly the URL segment we resolved the owning
  // personal org from — no extra lookup needed.
  return Result.ok(projectEntityToContract(project, username));
};
