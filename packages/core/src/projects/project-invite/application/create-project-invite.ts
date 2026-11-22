import crypto from "node:crypto";
import {
  createUuidV7,
  parseUuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type {
  DbExecutor,
  DbTransaction,
} from "@scarn/core/lib/db/db-executor";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import {
  isProjectRole,
  PROJECT_ROLE_NAMES,
} from "@scarn/core/projects/project/domain/project-role";
import { isProjectInviteRestriction } from "../domain/project-invite-restriction";
import type { ProjectInviteRepo } from "./project-invite-repo";
import { ProjectInviteEntity } from "../domain/project-invite-entity";

/** Minimal interface for looking up users by email. Satisfied by AuthUserRepo from @scarn/identity. */
export type EmailLookupRepo = {
  loadByEmail(email: string): Promise<{ id: string } | null>;
};

export type CreateProjectInviteInput = {
  projectId: UuidV7;
  email?: string;
  role: string;
  restriction: string;
  invitedByUserId: UuidV7;
};

export type CreateProjectInviteSuccess = {
  invite: ProjectInviteEntity;
  rawToken: string;
};

export type CreateProjectInviteError =
  | { code: "INVALID_ROLE"; message: string }
  | { code: "INVALID_RESTRICTION"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "INVITE_ALREADY_MEMBER"; message: string };

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export const createProjectInvite = async (
  input: CreateProjectInviteInput,
  {
    projectRepo,
    projectInviteRepo,
    authUserRepo,
    dbExecutor,
  }: {
    projectRepo: ProjectRepo;
    projectInviteRepo: ProjectInviteRepo;
    authUserRepo: EmailLookupRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<CreateProjectInviteSuccess, CreateProjectInviteError>> => {
  const { projectId, invitedByUserId } = input;

  if (!isProjectRole(input.role)) {
    return Result.err({
      code: "INVALID_ROLE",
      message: `Role must be one of: ${PROJECT_ROLE_NAMES.join(", ")}`,
    });
  }

  if (!isProjectInviteRestriction(input.restriction)) {
    return Result.err({
      code: "INVALID_RESTRICTION",
      message:
        "Invite restriction must be specific_email or any_authenticated_user",
    });
  }

  const role = input.role;
  const restriction = input.restriction;
  const normalizedEmail = input.email?.trim().toLowerCase() ?? null;

  if (restriction === "specific_email" && !normalizedEmail) {
    return Result.err({
      code: "INVALID_RESTRICTION",
      message: "Email is required for an invite restricted to a specific email",
    });
  }

  if (restriction === "any_authenticated_user" && normalizedEmail !== null) {
    return Result.err({
      code: "INVALID_RESTRICTION",
      message: "Unrestricted invite links cannot target a specific email",
    });
  }

  const runInTransaction = async (
    tx: DbTransaction,
  ): Promise<Result<CreateProjectInviteSuccess, CreateProjectInviteError>> => {
    const project = await projectRepo.load(projectId, tx);
    if (!project) {
      return Result.err({
        code: "UNAUTHORIZED",
        message: "Insufficient permissions",
      });
    }

    const callerMembership = project.getMembership(invitedByUserId);
    if (
      !callerMembership ||
      !callerMembership.permissions.includes("members:write")
    ) {
      return Result.err({
        code: "UNAUTHORIZED",
        message: "Insufficient permissions",
      });
    }

    // Check if the invited email belongs to an existing member
    if (restriction === "specific_email") {
      if (normalizedEmail === null) {
        return Result.err({
          code: "INVALID_RESTRICTION",
          message: "Email is required for an invite restricted to a specific email",
        });
      }

      const restrictedEmail = normalizedEmail;
      const existingUser = await authUserRepo.loadByEmail(restrictedEmail);
      if (existingUser) {
        const existingMembership = project.getMembership(
          parseUuidV7(existingUser.id),
        );
        if (existingMembership) {
          return Result.err({
            code: "INVITE_ALREADY_MEMBER",
            message: "This user is already in this project",
          });
        }
      }
    }

    const existingInvite =
      restriction === "specific_email" && normalizedEmail !== null
        ? await projectInviteRepo.loadPendingByProjectAndEmail(
            projectId,
            normalizedEmail,
            tx,
          )
        : null;

    if (existingInvite) {
      const revokedInvite = ProjectInviteEntity.create({
        ...existingInvite.toJSON(),
        status: "revoked",
        updatedAt: new Date(),
      });
      await projectInviteRepo.save(revokedInvite, tx);
    }

    // Generate token
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const invite = ProjectInviteEntity.create({
      id: createUuidV7(),
      projectId,
      email: normalizedEmail,
      role,
      restriction,
      tokenHash,
      invitedByUserId,
      status: "pending",
      expiresAt,
      acceptedAt: null,
      acceptedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });

    const savedInvite = await projectInviteRepo.save(invite, tx);

    return Result.ok({ invite: savedInvite, rawToken });
  };

  if (dbExecutor) {
    if ("transaction" in dbExecutor) {
      return await dbExecutor.transaction(async (tx) => runInTransaction(tx));
    }
    return await runInTransaction(dbExecutor);
  }

  return await getDb().transaction(async (tx) => runInTransaction(tx));
};
