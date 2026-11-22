import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AppContext } from "@scarn/core/lib/di";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { ProjectMembership } from "@scarn/core/projects/project/domain/project-membership";

/**
 * Gives `userId` the `admin` role on the `@scarn/local-dev` sandbox project,
 * creating the membership if needed. Seed reuses the project across runs, so
 * this upgrades a long-lived sandbox membership that predates the role.
 *
 * Callers must check the environment first: this bypasses project
 * authorization.
 */
export const grantLocalDevAdmin = async (
  appContext: AppContext,
  projectId: UuidV7,
  userId: UuidV7,
): Promise<void> => {
  const { projectRepo, timeProvider } = appContext;
  const project = await projectRepo.load(projectId);
  if (!project) {
    throw new ResourceNotFoundError("Project", projectId);
  }

  const now = timeProvider.now();
  const existing = project.getMembership(userId);
  const membership = existing
    ? existing.withRole("admin", now)
    : ProjectMembership.create({
        projectId,
        userId,
        role: "admin",
        createdAt: now,
        updatedAt: now,
      });

  await projectRepo.save(project.withMembership(membership, now));
};
