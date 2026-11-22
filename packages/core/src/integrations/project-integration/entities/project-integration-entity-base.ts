import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { WorkItemPlatform } from "@scarn/core/work-items/work-item/domain/work-item-platform";
import type { SecretKind } from "@scarn/core/secrets/secret/entities/secret-entity-base";

export const PROJECT_INTEGRATION_STATUSES = [
  "active",
  "paused",
  "error",
] as const;
export type ProjectIntegrationStatus =
  (typeof PROJECT_INTEGRATION_STATUSES)[number];

/** The integration kinds, matching the `project_integration_kind` pgEnum. */
export const PROJECT_INTEGRATION_KINDS = [
  "github_app",
  "github_token",
  "bitbucket",
  "jira",
] as const;
export type ProjectIntegrationKind = (typeof PROJECT_INTEGRATION_KINDS)[number];

export const PROJECT_INTEGRATION_AUTH_MODES = [
  "github_app",
  "user_credential",
] as const;
export type ProjectIntegrationAuthMode =
  (typeof PROJECT_INTEGRATION_AUTH_MODES)[number];

/** Why Scarn paused an integration's auto-sync. */
export const AUTO_SYNC_PAUSED_REASONS = [
  "key_removed",
  "key_rejected",
  "key_expired",
  "owner_left_project",
  "access_lost",
] as const;
export type AutoSyncPausedReason = (typeof AUTO_SYNC_PAUSED_REASONS)[number];

/**
 * The secret kind a member may lend to each kind of integration for
 * auto-sync. A kind missing here can't auto-sync.
 */
export const AUTO_SYNC_SECRET_KIND: Partial<
  Record<ProjectIntegrationKind, SecretKind>
> = {
  jira: "jira_api_key",
  github_token: "github_token",
};

export const supportsAutoSync = (integration: {
  kind: ProjectIntegrationKind;
}): boolean => AUTO_SYNC_SECRET_KIND[integration.kind] !== undefined;

/** The fields every project integration carries regardless of kind. */
export type ProjectIntegrationEntityBaseProps = {
  id: UuidV7;
  projectId: UuidV7;
  status: ProjectIntegrationStatus;
  lastSyncedAt: Date | null;
  lastError: string | null;
  firstSyncHorizonDays: number | null;
  syncSecretId: UuidV7 | null;
  autoSyncPausedReason: AutoSyncPausedReason | null;
  autoSyncPausedAt: Date | null;
  autoSyncPausedDetail: string | null;
  createdAt?: Date | null | undefined;
  updatedAt?: Date | null | undefined;
};

export type CreateProjectIntegrationEntityBaseProps = {
  id?: UuidV7 | undefined;
  projectId: UuidV7;
  firstSyncHorizonDays?: number | null | undefined;
};

/**
 * The flat `project_integrations` row shape every variant's `toJSON()`
 * returns and `ProjectIntegrationEntity.rehydrate` dispatches on. The
 * installation id is nullable and the scope is untyped JSON here; each
 * variant requires or forbids and parses them.
 */
export type ProjectIntegrationRowProps = ProjectIntegrationEntityBaseProps & {
  kind: ProjectIntegrationKind;
  installationId: string | null;
  externalScopeJson: AnyJsonValue;
};

export const createBaseProps = (
  props: CreateProjectIntegrationEntityBaseProps & { id: UuidV7 },
): ProjectIntegrationEntityBaseProps => ({
  id: props.id,
  projectId: props.projectId,
  status: "active",
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: props.firstSyncHorizonDays ?? null,
  syncSecretId: null,
  autoSyncPausedReason: null,
  autoSyncPausedAt: null,
  autoSyncPausedDetail: null,
});

/**
 * Shared base for every `ProjectIntegrationEntity` variant (see
 * `domain/project-integration-entity.ts` for the union). `platform` and
 * `authMode` are fixed by each variant's `kind`, so they can never disagree.
 * Transitions return `this` so a narrowed variant keeps its type.
 */
export abstract class ProjectIntegrationEntityBase {
  public abstract readonly kind: ProjectIntegrationKind;
  public abstract readonly platform: WorkItemPlatform;
  public abstract readonly authMode: ProjectIntegrationAuthMode;
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly status: ProjectIntegrationStatus;
  public readonly lastSyncedAt: Date | null;
  public readonly lastError: string | null;
  public readonly firstSyncHorizonDays: number | null;
  public readonly syncSecretId: UuidV7 | null;
  public readonly autoSyncPausedReason: AutoSyncPausedReason | null;
  public readonly autoSyncPausedAt: Date | null;
  public readonly autoSyncPausedDetail: string | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  /**
   * `kind` is passed in because a subclass's own `kind` field isn't set yet
   * while this constructor runs.
   */
  protected constructor(
    props: ProjectIntegrationEntityBaseProps,
    kind: ProjectIntegrationKind,
  ) {
    if (
      props.syncSecretId !== null &&
      AUTO_SYNC_SECRET_KIND[kind] === undefined
    ) {
      throw new CoreValidationError(
        `Project integration of kind '${kind}' does not support auto-sync`,
        "PROJECT_INTEGRATION_AUTO_SYNC_UNSUPPORTED",
      );
    }
    if (
      props.firstSyncHorizonDays !== null &&
      (!Number.isInteger(props.firstSyncHorizonDays) ||
        props.firstSyncHorizonDays < 0)
    ) {
      throw new CoreValidationError(
        "Project integration firstSyncHorizonDays must be a non-negative integer",
        "PROJECT_INTEGRATION_FIRST_SYNC_HORIZON_DAYS_INVALID",
      );
    }

    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.status = props.status;
    this.lastSyncedAt = props.lastSyncedAt;
    this.lastError = props.lastError;
    this.firstSyncHorizonDays = props.firstSyncHorizonDays;
    this.syncSecretId =
      props.syncSecretId === null ? null : parseUuidV7(props.syncSecretId);
    this.autoSyncPausedReason = props.autoSyncPausedReason;
    this.autoSyncPausedAt = props.autoSyncPausedAt;
    this.autoSyncPausedDetail = props.autoSyncPausedDetail;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /**
   * Rebuilds this variant with the given shared fields, carrying over its own
   * kind-specific fields unchanged.
   */
  protected abstract withBaseProps(
    props: ProjectIntegrationEntityBaseProps,
  ): this;

  abstract toJSON(): ProjectIntegrationRowProps;

  withSyncSuccess(syncedAt: Date): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      status: "active",
      lastSyncedAt: syncedAt,
      lastError: null,
    });
  }

  withSyncError(message: string, occurredAt: Date): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      status: "error",
      lastError: message,
      updatedAt: occurredAt,
    });
  }

  /** Turns auto-sync on with a lent key, clearing any earlier pause. */
  withAutoSync(secretId: UuidV7): this {
    return this.withAutoSyncPauseCleared(secretId);
  }

  /** A person turned auto-sync off: the key is cleared with no reason. */
  withAutoSyncOff(): this {
    return this.withAutoSyncPauseCleared(null);
  }

  /**
   * Sets the lent key and clears the auto-sync pause. A `paused` status that
   * auto-sync caused goes back to `active`; any other status is kept.
   */
  private withAutoSyncPauseCleared(syncSecretId: UuidV7 | null): this {
    const pausedByAutoSync =
      this.status === "paused" && this.autoSyncPausedReason !== null;
    return this.withBaseProps({
      ...this.baseJSON(),
      status: pausedByAutoSync ? "active" : this.status,
      syncSecretId,
      autoSyncPausedReason: null,
      autoSyncPausedAt: null,
      autoSyncPausedDetail: null,
    });
  }

  /** Scarn paused auto-sync because the lent key can't be used. */
  withAutoSyncPaused(
    reason: AutoSyncPausedReason,
    at: Date,
    detail: string | null = null,
  ): this {
    return this.withBaseProps({
      ...this.baseJSON(),
      status: "paused",
      syncSecretId: null,
      autoSyncPausedReason: reason,
      autoSyncPausedAt: at,
      autoSyncPausedDetail: detail,
      updatedAt: at,
    });
  }

  protected baseJSON(): ProjectIntegrationEntityBaseProps {
    return {
      id: this.id,
      projectId: this.projectId,
      status: this.status,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      firstSyncHorizonDays: this.firstSyncHorizonDays,
      syncSecretId: this.syncSecretId,
      autoSyncPausedReason: this.autoSyncPausedReason,
      autoSyncPausedAt: this.autoSyncPausedAt,
      autoSyncPausedDetail: this.autoSyncPausedDetail,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
