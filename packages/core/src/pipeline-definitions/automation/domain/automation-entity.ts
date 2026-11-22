import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import type { AutomationScope } from "@scarn/sdk/contracts/automation-document";

export type AutomationEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  key: string;
  title: string | null;
  scope: AutomationScope;
  enabled: boolean;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateAutomationEntityProps = Omit<
  AutomationEntityProps,
  "id" | "enabled"
> & { id?: UuidV7 | undefined };

/**
 * An automation in a project, identified by its key. Its rules live in its
 * versions; the latest published version is the one that runs.
 *
 * `enabled` only means something for project automations, which run on
 * every top-level work item once enabled. It starts false, so a first push
 * doesn't start firing. Work-item automations run where they're attached,
 * so they can't be enabled or disabled.
 */
export class AutomationEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly key: string;
  public readonly title: string | null;
  public readonly scope: AutomationScope;
  public readonly enabled: boolean;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: AutomationEntityProps) {
    const key = props.key.trim();
    if (!key) {
      throw new CoreValidationError(
        "Automation key is required",
        "AUTOMATION_KEY_REQUIRED",
      );
    }
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.key = key;
    this.title = props.title?.trim() || null;
    this.scope = props.scope;
    this.enabled = props.scope === "project" && props.enabled;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  static create(props: CreateAutomationEntityProps): AutomationEntity {
    return new AutomationEntity({
      ...props,
      id: props.id ?? createUuidV7(),
      enabled: false,
    });
  }

  static rehydrate(props: AutomationEntityProps): AutomationEntity {
    return new AutomationEntity(props);
  }

  withTitle(title: string | null, now: Date): AutomationEntity {
    return new AutomationEntity({ ...this.toJSON(), title, updatedAt: now });
  }

  /** Only project automations can be enabled; callers check {@link scope} first. */
  setEnabled(enabled: boolean, now: Date): AutomationEntity {
    if (this.scope !== "project") {
      throw new CoreValidationError(
        "Only a project automation can be enabled or disabled",
        "AUTOMATION_NOT_PROJECT_SCOPE",
      );
    }
    return new AutomationEntity({ ...this.toJSON(), enabled, updatedAt: now });
  }

  toJSON(): AutomationEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      key: this.key,
      title: this.title,
      scope: this.scope,
      enabled: this.enabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
