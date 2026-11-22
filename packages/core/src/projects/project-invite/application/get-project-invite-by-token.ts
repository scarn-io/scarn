import crypto from "node:crypto";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { resolveProjectOwnerUsernames } from "@scarn/core/projects/project/application/resolve-project-owner-usernames";
import type { ProjectRole } from "@scarn/core/projects/project/domain/project-role";
import type { ProjectInviteRestriction } from "../domain/project-invite-restriction";
import type { ProjectInviteStatus } from "../domain/project-invite-status";
import type { ProjectInviteRepo } from "./project-invite-repo";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";

export type PublicInviteDetails = {
  inviteId: string;
  projectId: string;
  projectName: string;
  // Read-time fields (decision D4: resolved from ids at read time, never
  // persisted on the invite row) needed to build the project's pretty URL
  // `/{ownerUsername}/{projectSlug}` after the invitee accepts.
  projectSlug: string;
  ownerUsername: string | null;
  role: ProjectRole;
  restriction: ProjectInviteRestriction;
  permissions: ProjectPermission[];
  status: ProjectInviteStatus;
  expiresAt: Date;
};

export type GetProjectInviteByTokenError = {
  code: "INVITE_NOT_FOUND";
  message: string;
};

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export const getProjectInviteByToken = async (
  input: { rawToken: string },
  {
    projectInviteRepo,
    projectRepo,
    orgRepo,
    usernameReader,
    dbExecutor,
  }: {
    projectInviteRepo: ProjectInviteRepo;
    projectRepo: ProjectRepo;
    orgRepo: OrgRepo;
    usernameReader: UsernameReader;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<PublicInviteDetails, GetProjectInviteByTokenError>> => {
  const tokenHash = hashToken(input.rawToken);

  const invite = await projectInviteRepo.loadByTokenHash(tokenHash, dbExecutor);
  if (!invite) {
    return Result.err({
      code: "INVITE_NOT_FOUND",
      message: "Invite not found",
    });
  }

  const project = await projectRepo.load(invite.projectId, dbExecutor);
  if (!project) {
    return Result.err({
      code: "INVITE_NOT_FOUND",
      message: "Invite not found",
    });
  }

  // Resolve the OWNER username at read time (owning org → owner user id →
  // username), reusing the same helper as list-projects/get-project. Absent
  // from the map (and so `null`) when the owner has no resolvable username.
  const ownerUsernameByProjectId = await resolveProjectOwnerUsernames([project], {
    orgRepo,
    usernameReader,
    dbExecutor,
  });

  return Result.ok({
    inviteId: invite.id,
    projectId: invite.projectId,
    projectName: project.name,
    projectSlug: project.slug,
    ownerUsername: ownerUsernameByProjectId.get(project.id) ?? null,
    role: invite.role,
    restriction: invite.restriction,
    permissions: [...invite.permissions],
    status: invite.status,
    expiresAt: invite.expiresAt,
  });
};
