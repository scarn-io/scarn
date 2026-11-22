import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { AutomationScope } from "@scarn/sdk/contracts/automation-document";
import type { AutomationEntity } from "../domain/automation-entity";
import type { AutomationVersionEntity } from "../domain/automation-version-entity";

/** An automation with its latest published version (null only before the first publish completes). */
export type ResolvedAutomation = {
  automation: AutomationEntity;
  latestVersion: AutomationVersionEntity | null;
};

export type AutomationRepo = {
  findByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity | null>;
  /** Loads the automation with `SELECT … FOR UPDATE`, serialising publishes. */
  lockByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor: DbExecutor,
  ): Promise<AutomationEntity | null>;
  loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity[]>;
  /** Every automation in the project with its latest version, in key order. */
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedAutomation[]>;
  /** Enabled project automations with their latest version, in key order. */
  listEnabledProjectAutomations(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedAutomation[]>;
  /** The scope of every automation in the project, by key. */
  scopesByKey(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Map<string, AutomationScope>>;
  /** Inserts the automation, or returns null when the project already has one with this key. */
  insert(
    automation: AutomationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity | null>;
  update(
    automation: AutomationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationEntity>;
  loadLatestVersion(
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationVersionEntity | null>;
  insertVersion(
    version: AutomationVersionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<AutomationVersionEntity>;
};
