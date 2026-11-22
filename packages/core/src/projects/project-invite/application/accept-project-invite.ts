import crypto from "node:crypto";
import {
  cancelManagedConsentForActor,
  type CancelManagedConsentForActorDeps,
} from "@scarn/core/connections/managed-mcp-connection/application/cancel-managed-consent-for-actor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import { Result } from "@scarn/core/lib/result";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { ProjectMembership } from "@scarn/core/projects/project/domain/project-membership";
import type { ProjectInviteEntity } from "../domain/project-invite-entity";
import { ProjectInviteEntity as ProjectInviteEntityClass } from "../domain/project-invite-entity";
import type { ProjectInviteRepo } from "./project-invite-repo";

export type AcceptProjectInviteInput = {
  rawToken: string;
  actorId: UuidV7;
  actorEmail: string;
};

export type AcceptProjectInviteError =
  | { code: "INVITE_NOT_FOUND"; message: string }
  | { code: "INVITE_NOT_PENDING"; message: string }
  | { code: "INVITE_EXPIRED"; message: string }
  | { code: "INVITE_EMAIL_MISMATCH"; message: string };

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export const acceptProjectInvite = async (
  input: AcceptProjectInviteInput,
  {
    projectInviteRepo,
    projectRepo,
    analytics,
    dbExecutor,
    ...consentDeps
  }: {
    projectInviteRepo: ProjectInviteRepo;
    projectRepo: ProjectRepo;
    analytics: AnalyticsPort;
    dbExecutor?: DbExecutor | undefined;
  } & CancelManagedConsentForActorDeps,
): Promise<Result<ProjectInviteEntity, AcceptProjectInviteError>> => {
  const { rawToken, actorId, actorEmail } = input;
  const tokenHash = hashToken(rawToken);

  const runInTransaction = async (
    tx: DbTransaction,
  ): Promise<
    Result<
      { invite: ProjectInviteEntity; newMember: boolean },
      AcceptProjectInviteError
    >
  > => {
    const invite = await projectInviteRepo.loadByTokenHash(tokenHash, tx);
    if (!invite) {
      return Result.err({
        code: "INVITE_NOT_FOUND",
        message: "Invite not found",
      });
    }

    if (invite.status !== "pending") {
      return Result.err({
        code: "INVITE_NOT_PENDING",
        message: "This invite is no longer valid",
      });
    }

    if (invite.isExpired()) {
      return Result.err({
        code: "INVITE_EXPIRED",
        message: "This invite has expired",
      });
    }

    const normalizedActorEmail = actorEmail.trim().toLowerCase();
    if (
      invite.restriction === "specific_email" &&
      normalizedActorEmail !== invite.email
    ) {
      return Result.err({
        code: "INVITE_EMAIL_MISMATCH",
        message: "This invite was sent to a different email address",
      });
    }

    const project = await projectRepo.loadForUpdate(invite.projectId, tx);
    if (!project) {
      return Result.err({
        code: "INVITE_NOT_FOUND",
        message: "Invite not found",
      });
    }

    const now = new Date();
    const existingMembership = project.getMembership(actorId);
    const membership = existingMembership
      ? existingMembership.withRole(invite.role, now)
      : ProjectMembership.create({
          projectId: project.id,
          userId: actorId,
          role: invite.role,
          createdAt: now,
          updatedAt: now,
        });

    await projectRepo.save(project.withMembership(membership, now), tx);

    if (
      existingMembership?.permissions.includes("secrets:write") &&
      !membership.permissions.includes("secrets:write")
    ) {
      await cancelManagedConsentForActor(
        { projectId: project.id, userId: actorId },
        consentDeps,
        tx,
      );
    }

    const acceptedInvite = ProjectInviteEntityClass.create({
      ...invite.toJSON(),
      status: "accepted",
      acceptedAt: now,
      acceptedByUserId: actorId,
      updatedAt: now,
    });

    const savedInvite = await projectInviteRepo.save(acceptedInvite, tx);

    return Result.ok({ invite: savedInvite, newMember: !existingMembership });
  };

  const executor = dbExecutor ?? getDb();
  const result =
    "transaction" in executor
      ? await executor.transaction(async (tx) => runInTransaction(tx))
      : await runInTransaction(executor);
  if (!result.ok) {
    return result;
  }

  const { invite, newMember } = result.value;
  analytics.capture(actorId, AnalyticsEvents.InviteAccepted, {
    project_id: invite.projectId,
    role: invite.role,
    new_member: newMember,
  });

  return Result.ok(invite);
};
