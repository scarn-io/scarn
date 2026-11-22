import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { projectInvites } from "@scarn/core/lib/db/schema";
import type { ProjectInviteRepo } from "../application/project-invite-repo";
import {
  ProjectInviteEntity,
  type ProjectInviteProps,
} from "../domain/project-invite-entity";
import {
  isProjectInviteRestriction,
  type ProjectInviteRestriction,
} from "../domain/project-invite-restriction";
import { isProjectRole } from "@scarn/core/projects/project/domain/project-role";
import { isProjectInviteStatus } from "../domain/project-invite-status";

const toRow = (invite: ProjectInviteEntity) => ({
  id: invite.id,
  projectId: invite.projectId,
  email: invite.email,
  role: invite.role,
  restriction: invite.restriction,
  tokenHash: invite.tokenHash,
  invitedByUserId: invite.invitedByUserId,
  status: invite.status,
  expiresAt: invite.expiresAt,
  acceptedAt: invite.acceptedAt ?? null,
  acceptedByUserId: invite.acceptedByUserId ?? null,
  createdAt: invite.createdAt,
  updatedAt: invite.updatedAt,
});

export class DrizzleProjectInviteRepo implements ProjectInviteRepo {
  private toEntity(
    row: typeof projectInvites.$inferSelect,
  ): ProjectInviteEntity {
    const role = row.role;
    if (!isProjectRole(role)) {
      throw new Error(`Invalid project invite role: ${role}`);
    }

    const restriction = row.restriction;
    if (!isProjectInviteRestriction(restriction)) {
      throw new Error(`Invalid project invite restriction: ${restriction}`);
    }

    const status = row.status;
    if (!isProjectInviteStatus(status)) {
      throw new Error(`Invalid project invite status: ${status}`);
    }

    return ProjectInviteEntity.rehydrate({
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      email: row.email,
      role,
      restriction,
      tokenHash: row.tokenHash,
      invitedByUserId: parseUuidV7(row.invitedByUserId),
      status,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt ?? null,
      acceptedByUserId: row.acceptedByUserId
        ? parseUuidV7(row.acceptedByUserId)
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies ProjectInviteProps);
  }

  async save(
    invite: ProjectInviteEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(projectInvites)
      .values(toRow(invite))
      .onConflictDoUpdate({
        target: projectInvites.id,
        set: {
          email: sql`excluded.email`,
          role: sql`excluded.role`,
          restriction: sql`excluded.restriction`,
          tokenHash: sql`excluded.token_hash`,
          status: sql`excluded.status`,
          expiresAt: sql`excluded.expires_at`,
          acceptedAt: sql`excluded.accepted_at`,
          acceptedByUserId: sql`excluded.accepted_by_user_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();

    if (!row) {
      throw new Error("Failed to save project invite");
    }

    return this.toEntity(row);
  }

  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.id, id));

    return row ? this.toEntity(row) : null;
  }

  async loadByTokenHash(
    tokenHash: string,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.tokenHash, tokenHash));

    return row ? this.toEntity(row) : null;
  }

  async loadPendingByProjectAndEmail(
    projectId: UuidV7,
    email: string,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.projectId, projectId),
          eq(projectInvites.email, email),
          eq(projectInvites.restriction, "specific_email"),
          eq(projectInvites.status, "pending"),
        ),
      );

    return row ? this.toEntity(row) : null;
  }

  async loadPendingByProjectAndRestriction(
    projectId: UuidV7,
    restriction: ProjectInviteRestriction,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.projectId, projectId),
          eq(projectInvites.restriction, restriction),
          eq(projectInvites.status, "pending"),
        ),
      );

    return row ? this.toEntity(row) : null;
  }

  async listPendingByProject(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.projectId, projectId),
          eq(projectInvites.status, "pending"),
        ),
      );

    return rows.map((row) => this.toEntity(row));
  }

  async saveMany(
    invites: ProjectInviteEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity[]> {
    if (invites.length === 0) {
      return [];
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .insert(projectInvites)
      .values(invites.map(toRow))
      .onConflictDoUpdate({
        target: projectInvites.id,
        set: {
          email: sql`excluded.email`,
          role: sql`excluded.role`,
          restriction: sql`excluded.restriction`,
          tokenHash: sql`excluded.token_hash`,
          status: sql`excluded.status`,
          expiresAt: sql`excluded.expires_at`,
          acceptedAt: sql`excluded.accepted_at`,
          acceptedByUserId: sql`excluded.accepted_by_user_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();

    return rows.map((row) => this.toEntity(row));
  }
}
