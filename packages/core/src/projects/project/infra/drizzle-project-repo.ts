import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { projectMemberships, projects } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import { type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ProjectRepo } from "../application/project-repo";
import {
  ProjectEntity,
  type ProjectEntityProps,
} from "../domain/project-entity";

type ProjectRow = typeof projects.$inferSelect;
type ProjectMembershipRow = typeof projectMemberships.$inferSelect;

const toProjectRow = (project: ProjectEntity) => ({
  id: project.id,
  name: project.name,
  slug: project.slug,
  description: project.description,
  gitUrl: project.gitUrl,
  createdByUserId: project.createdByUserId,
  orgId: project.orgId,
  visibility: project.visibility,
  createdAt: project.createdAt ?? new Date(),
  updatedAt: project.updatedAt ?? new Date(),
});

const toMembershipRows = (project: ProjectEntity) =>
  project.memberships.map((membership) => ({
    projectId: project.id,
    userId: membership.userId,
    role: membership.role,
    createdAt: membership.createdAt ?? new Date(),
    updatedAt: membership.updatedAt ?? new Date(),
  }));

export class DrizzleProjectRepo implements ProjectRepo {
  private toEntity(
    projectRow: ProjectRow,
    membershipRows: ProjectMembershipRow[],
  ): ProjectEntity {
    return ProjectEntity.rehydrate({
      id: projectRow.id as ProjectEntityProps["id"],
      name: projectRow.name,
      slug: projectRow.slug,
      description: projectRow.description,
      gitUrl: projectRow.gitUrl,
      createdByUserId:
        projectRow.createdByUserId as ProjectEntityProps["createdByUserId"],
      orgId: projectRow.orgId as ProjectEntityProps["orgId"],
      memberships: membershipRows.map((membershipRow) => ({
        projectId: membershipRow.projectId as ProjectEntityProps["id"],
        userId: membershipRow.userId as ProjectEntityProps["createdByUserId"],
        role: membershipRow.role,
        createdAt: membershipRow.createdAt,
        updatedAt: membershipRow.updatedAt,
      })),
      visibility: projectRow.visibility,
      createdAt: projectRow.createdAt,
      updatedAt: projectRow.updatedAt,
    });
  }

  async load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity | null> {
    const db = dbExecutor ?? getDb();
    const [projectRow] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);

    if (!projectRow) {
      return null;
    }

    const membershipRows = await db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.projectId, id));

    return this.toEntity(projectRow, membershipRows);
  }

  async loadForUpdate(
    id: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<ProjectEntity | null> {
    const [projectRow] = await dbExecutor
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
      .for("update");

    if (!projectRow) {
      return null;
    }

    const membershipRows = await dbExecutor
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.projectId, id));

    return this.toEntity(projectRow, membershipRows);
  }

  async loadByOrgAndSlug(
    orgId: UuidV7,
    slug: string,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity | null> {
    const db = dbExecutor ?? getDb();
    const [projectRow] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
      .limit(1);

    if (!projectRow) {
      return null;
    }

    const membershipRows = await db
      .select()
      .from(projectMemberships)
      .where(eq(projectMemberships.projectId, projectRow.id));

    return this.toEntity(projectRow, membershipRows);
  }

  async listSlugsByOrg(
    orgId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<string[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.orgId, orgId));

    return rows.map((row) => row.slug);
  }

  async listByUser(
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        project: projects,
        membership: projectMemberships,
      })
      .from(projectMemberships)
      .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
      .where(eq(projectMemberships.userId, userId));

    const projectIds = [
      ...new Set(rows.map((row) => row.project.id as UuidV7)),
    ];
    const membershipRows = projectIds.length
      ? await db
          .select()
          .from(projectMemberships)
          .where(inArray(projectMemberships.projectId, projectIds))
      : [];

    return projectIds.map((projectId) => {
      const projectRow = rows.find(
        (row) => row.project.id === projectId,
      )?.project;

      if (!projectRow) {
        throw new PersistenceError(
          `Failed to load project ${projectId}`,
          "PROJECT_LOAD_FAILED",
        );
      }

      return this.toEntity(
        projectRow,
        membershipRows.filter(
          (membershipRow) => membershipRow.projectId === projectId,
        ),
      );
    });
  }

  async loadMany(
    ids: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity[]> {
    if (ids.length === 0) return [];
    const db = dbExecutor ?? getDb();

    const projectRows = await db
      .select()
      .from(projects)
      .where(inArray(projects.id, ids));

    if (projectRows.length === 0) return [];

    const membershipRows = await db
      .select()
      .from(projectMemberships)
      .where(
        inArray(
          projectMemberships.projectId,
          projectRows.map((r) => r.id),
        ),
      );

    return projectRows.map((projectRow) =>
      this.toEntity(
        projectRow,
        membershipRows.filter((m) => m.projectId === projectRow.id),
      ),
    );
  }

  async create(
    project: ProjectEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity> {
    const createInExecutor = async (tx: DbExecutor) => {
      const [projectRow] = await tx
        .insert(projects)
        .values(toProjectRow(project))
        .returning();

      if (!projectRow) {
        throw new PersistenceError(
          `Failed to create project ${project.id}`,
          "PROJECT_CREATE_FAILED",
        );
      }

      const membershipRows = await tx
        .insert(projectMemberships)
        .values(toMembershipRows(project))
        .returning();

      return this.toEntity(projectRow, membershipRows);
    };

    if (dbExecutor) {
      return await createInExecutor(dbExecutor);
    }

    return await getDb().transaction(async (tx) => await createInExecutor(tx));
  }

  async save(
    project: ProjectEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectEntity> {
    const saveInExecutor = async (tx: DbExecutor) => {
      const [projectRow] = await tx
        .insert(projects)
        .values(toProjectRow(project))
        .onConflictDoUpdate({
          target: projects.id,
          set: {
            name: project.name,
            slug: project.slug,
            description: project.description,
            gitUrl: project.gitUrl,
            createdByUserId: project.createdByUserId,
            orgId: project.orgId,
            visibility: project.visibility,
            updatedAt: project.updatedAt ?? new Date(),
          },
        })
        .returning();

      if (!projectRow) {
        throw new PersistenceError(
          `Failed to save project ${project.id}`,
          "PROJECT_SAVE_FAILED",
        );
      }

      for (const membershipRow of toMembershipRows(project)) {
        await tx
          .insert(projectMemberships)
          .values(membershipRow)
          .onConflictDoUpdate({
            target: [projectMemberships.projectId, projectMemberships.userId],
            set: {
              role: membershipRow.role,
              updatedAt: membershipRow.updatedAt,
            },
          });
      }

      const membershipRows = await tx
        .select()
        .from(projectMemberships)
        .where(eq(projectMemberships.projectId, project.id));

      return this.toEntity(projectRow, membershipRows);
    };

    if (dbExecutor) {
      return await saveInExecutor(dbExecutor);
    }

    return await getDb().transaction(async (tx) => await saveInExecutor(tx));
  }
}
