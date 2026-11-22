import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";

export const GITHUB_INSTALLATION_ACCOUNT_TYPES = [
  "User",
  "Organization",
] as const;
export type GitHubInstallationAccountType =
  (typeof GITHUB_INSTALLATION_ACCOUNT_TYPES)[number];

export const GITHUB_INSTALLATION_TARGET_TYPES = ["all", "selected"] as const;
export type GitHubInstallationTargetType =
  (typeof GITHUB_INSTALLATION_TARGET_TYPES)[number];

export type GitHubInstallationRepository = {
  id: number;
  fullName: string;
};

export type GitHubInstallationEntityProps = {
  id: UuidV7;
  installationId: string;
  accountLogin: string | null;
  accountType: GitHubInstallationAccountType | null;
  targetType: GitHubInstallationTargetType | null;
  selectedRepositories: GitHubInstallationRepository[] | null;
  installedByUserId?: UuidV7 | null | undefined;
  createdAt?: Date | null | undefined;
  updatedAt?: Date | null | undefined;
};

export type CreateGitHubInstallationProps = Omit<
  GitHubInstallationEntityProps,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: UuidV7 | undefined;
};

export class GitHubInstallationEntity {
  public readonly id: UuidV7;
  public readonly installationId: string;
  public readonly accountLogin: string | null;
  public readonly accountType: GitHubInstallationAccountType | null;
  public readonly targetType: GitHubInstallationTargetType | null;
  public readonly selectedRepositories: GitHubInstallationRepository[] | null;
  public readonly installedByUserId: UuidV7 | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: GitHubInstallationEntityProps) {
    const installationId = props.installationId.trim();
    if (!installationId) {
      throw new CoreValidationError(
        "GitHub installationId is required",
        "GITHUB_INSTALLATION_ID_REQUIRED",
      );
    }

    this.id = parseUuidV7(props.id);
    this.installationId = installationId;
    this.accountLogin = props.accountLogin?.trim() || null;
    this.accountType = props.accountType;
    this.targetType = props.targetType;
    this.selectedRepositories = props.selectedRepositories;
    this.installedByUserId = props.installedByUserId
      ? parseUuidV7(props.installedByUserId)
      : null;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static create(
    props: CreateGitHubInstallationProps,
  ): GitHubInstallationEntity {
    return new GitHubInstallationEntity({
      ...props,
      id: props.id ?? createUuidV7(),
      createdAt: undefined,
      updatedAt: undefined,
    });
  }

  static rehydrate(
    props: GitHubInstallationEntityProps,
  ): GitHubInstallationEntity {
    return new GitHubInstallationEntity(props);
  }

  withMetadata(metadata: {
    accountLogin: string | null;
    accountType: GitHubInstallationAccountType | null;
    targetType: GitHubInstallationTargetType | null;
    selectedRepositories: GitHubInstallationRepository[] | null;
    // Omit (or pass `undefined`) to leave the current owner untouched — most
    // metadata refreshes (webhooks, repo-removal, non-owning callers) have no
    // opinion on ownership. Pass a `UuidV7` (or explicit `null`) to set it.
    installedByUserId?: UuidV7 | null | undefined;
  }): GitHubInstallationEntity {
    return new GitHubInstallationEntity({
      id: this.id,
      installationId: this.installationId,
      accountLogin: metadata.accountLogin,
      accountType: metadata.accountType,
      targetType: metadata.targetType,
      selectedRepositories: metadata.selectedRepositories,
      installedByUserId:
        metadata.installedByUserId !== undefined
          ? metadata.installedByUserId
          : this.installedByUserId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }
}
