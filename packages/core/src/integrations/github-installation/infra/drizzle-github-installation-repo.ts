import { eq } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { githubInstallations } from "@scarn/core/lib/db/schema";
import type { GitHubInstallationRepo } from "../application/github-installation-repo";
import { readStoredGitHubInstallationRepositories } from "../contracts/github-installation-repositories-stored";
import {
  GITHUB_INSTALLATION_ACCOUNT_TYPES,
  GITHUB_INSTALLATION_TARGET_TYPES,
  GitHubInstallationEntity,
  type GitHubInstallationAccountType,
  type GitHubInstallationRepository,
  type GitHubInstallationTargetType,
} from "../domain/github-installation-entity";

const parseAccountType = (
  value: string | null,
): GitHubInstallationAccountType | null => {
  if (!value) return null;
  return (GITHUB_INSTALLATION_ACCOUNT_TYPES as readonly string[]).includes(
    value,
  )
    ? (value as GitHubInstallationAccountType)
    : null;
};

const parseTargetType = (
  value: string | null,
): GitHubInstallationTargetType | null => {
  if (!value) return null;
  return (GITHUB_INSTALLATION_TARGET_TYPES as readonly string[]).includes(value)
    ? (value as GitHubInstallationTargetType)
    : null;
};

const selectedRepositoriesFromRow = (
  row: typeof githubInstallations.$inferSelect,
): GitHubInstallationRepository[] | null => {
  const read = readStoredGitHubInstallationRepositories(
    row.selectedRepositoriesJson,
  );
  return read.success ? read.value : null;
};

const toRow = (installation: GitHubInstallationEntity) => ({
  id: installation.id,
  installationId: installation.installationId,
  accountLogin: installation.accountLogin,
  accountType: installation.accountType,
  targetType: installation.targetType,
  selectedRepositoriesJson: installation.selectedRepositories,
  installedByUserId: installation.installedByUserId,
  createdAt: installation.createdAt ?? new Date(),
  updatedAt: installation.updatedAt ?? new Date(),
});

export class DrizzleGitHubInstallationRepo implements GitHubInstallationRepo {
  private toEntity(
    row: typeof githubInstallations.$inferSelect,
  ): GitHubInstallationEntity {
    return GitHubInstallationEntity.rehydrate({
      id: parseUuidV7(row.id),
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      accountType: parseAccountType(row.accountType),
      targetType: parseTargetType(row.targetType),
      selectedRepositories: selectedRepositoriesFromRow(row),
      installedByUserId: row.installedByUserId
        ? parseUuidV7(row.installedByUserId)
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async upsert(
    installation: GitHubInstallationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubInstallationEntity> {
    const db = dbExecutor ?? getDb();
    const row = toRow(installation);
    const [updated] = await db
      .insert(githubInstallations)
      .values(row)
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          accountLogin: row.accountLogin,
          accountType: row.accountType,
          targetType: row.targetType,
          selectedRepositoriesJson: row.selectedRepositoriesJson,
          installedByUserId: row.installedByUserId,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!updated) {
      throw new Error("Failed to upsert github installation");
    }

    return this.toEntity(updated);
  }

  async findByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubInstallationEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async findByInstalledByUserId(
    userId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<GitHubInstallationEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installedByUserId, userId));

    return rows.map((row) => this.toEntity(row));
  }

  async deleteByInstallationId(
    installationId: string,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .returning({ id: githubInstallations.id });

    return rows.length;
  }
}
