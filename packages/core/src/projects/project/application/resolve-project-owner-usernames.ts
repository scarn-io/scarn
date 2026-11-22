import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ProjectEntity } from "../domain/project-entity";

type ResolveProjectOwnerUsernamesDeps = {
  orgRepo: OrgRepo;
  usernameReader: UsernameReader;
  dbExecutor?: DbExecutor | undefined;
};

/**
 * Batch-resolve the OWNER username for each project (decision D4: resolve at
 * read time, never persist the username on the project row). The owner is the
 * owning organization's owner user; its username is the first URL segment in a
 * project's pretty URL (`/{ownerUsername}/{slug}`).
 *
 * Two round-trips total regardless of project count: org id → owner user id,
 * then owner user id → username. Projects whose owner cannot be resolved (org
 * missing, no owner, or no username) are simply absent from the returned map so
 * callers fall back to `null`.
 */
export const resolveProjectOwnerUsernames = async (
  projects: readonly ProjectEntity[],
  { orgRepo, usernameReader, dbExecutor }: ResolveProjectOwnerUsernamesDeps,
): Promise<Map<UuidV7, string>> => {
  if (projects.length === 0) {
    return new Map<UuidV7, string>();
  }

  const ownerByOrgId = await orgRepo.loadOwnerUserIdsByOrgId(
    projects.map((project) => project.orgId),
    dbExecutor,
  );

  const usernameByUserId = await usernameReader.loadUsernamesByUserId(
    [...new Set(ownerByOrgId.values())],
    dbExecutor,
  );

  const ownerUsernameByProjectId = new Map<UuidV7, string>();
  for (const project of projects) {
    const ownerUserId = ownerByOrgId.get(project.orgId);
    const username =
      ownerUserId === undefined
        ? null
        : (usernameByUserId.get(ownerUserId)?.username ?? null);
    if (username !== null) {
      ownerUsernameByProjectId.set(project.id, username);
    }
  }
  return ownerUsernameByProjectId;
};
