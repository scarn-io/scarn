import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { WorkItemPlatform } from "@scarn/core/work-items/work-item/domain/work-item-platform";

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

/** The fields every project integration carries regardless of kind. */
export type ProjectIntegrationEntityBaseProps = {
  id: UuidV7;
  projectId: UuidV7;
  status: ProjectIntegrationStatus;
  lastSyncedAt: Date | null;
  lastError: string | null;
  firstSyncHorizonDays: number | null;
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
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  protected constructor(props: ProjectIntegrationEntityBaseProps) {
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

  protected baseJSON(): ProjectIntegrationEntityBaseProps {
    return {
      id: this.id,
      projectId: this.projectId,
      status: this.status,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      firstSyncHorizonDays: this.firstSyncHorizonDays,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
