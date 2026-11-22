import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { getDb } from "@scarn/core/lib/db";
import {
  cancelManagedConsentForActor,
  type CancelManagedConsentForActorDeps,
} from "@scarn/core/connections/managed-mcp-connection/application/cancel-managed-consent-for-actor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import { projectMembershipToContract } from "./project-contract-mapper";
import { assertProjectPermission } from "./project-authorization";
import type { ProjectRepo } from "./project-repo";
import { ProjectMembership } from "../domain/project-membership";
import type { ProjectEntity } from "../domain/project-entity";
import {
  updateProjectMembershipInputSchema,
  type ProjectMembershipContract,
  type UpdateProjectMembershipInput,
} from "../contracts/project-contracts";

const assertNotLastAdmin = (
  project: ProjectEntity,
  existingMembership: ProjectMembership | null,
  role: string,
) => {
  if (existingMembership?.role !== "admin" || role === "admin") {
    return;
  }
  const adminCount = project.memberships.filter(
    (membership) => membership.role === "admin",
  ).length;
  if (adminCount <= 1) {
    throw new CoreError({
      code: "PROJECT_LAST_ADMIN",
      message:
        "A project needs at least one admin. Make another member an admin first.",
      status: 409,
    });
  }
};

/**
 * Sets a user's role on a project. Changes an existing member's role, or adds
 * the user as a member with that role when they have none (invites are the
 * user-facing way to add people; this upsert is kept for admin tooling and
 * tests). Refuses to demote the project's only admin.
 */
export const updateProjectMembership = async (
  input: UpdateProjectMembershipInput,
  {
    userAuthz,
    projectRepo,
    timeProvider,
    dbExecutor,
    ...consentDeps
  }: {
    userAuthz: UserAuthorizationService;
    projectRepo: ProjectRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  } & CancelManagedConsentForActorDeps,
): Promise<Result<ProjectMembershipContract, ResourceNotFoundError>> => {
  const parsedInput = updateProjectMembershipInputSchema.parse(input);
  const projectId = parsedInput["projectId"];
  const targetUserId = parsedInput["userId"];
  const role = parsedInput["role"];
  const runInTransaction = async (tx: DbExecutor) => {
    const project = await projectRepo.loadForUpdate(projectId, tx);

    if (!project) {
      return Result.err(new ResourceNotFoundError("Project", projectId));
    }

    assertProjectPermission(project, userAuthz.actorId, "members:write");

    const existingMembership = project.getMembership(targetUserId);
    assertNotLastAdmin(project, existingMembership, role);

    const now = timeProvider.now();
    const membership = existingMembership
      ? existingMembership.withRole(role, now)
      : ProjectMembership.create({
          projectId: project.id,
          userId: targetUserId,
          role,
          createdAt: now,
          updatedAt: now,
        });

    const savedProject = await projectRepo.save(
      project.withMembership(membership, now),
      tx,
    );

    if (
      existingMembership?.permissions.includes("secrets:write") &&
      !membership.permissions.includes("secrets:write")
    ) {
      await cancelManagedConsentForActor(
        { projectId, userId: targetUserId },
        { ...consentDeps, timeProvider },
        tx,
      );
    }

    return Result.ok(
      projectMembershipToContract(
        savedProject.getMembership(targetUserId) ?? membership,
      ),
    );
  };

  const executor = dbExecutor ?? getDb();
  return "transaction" in executor
    ? await executor.transaction(runInTransaction)
    : await runInTransaction(executor);
};
