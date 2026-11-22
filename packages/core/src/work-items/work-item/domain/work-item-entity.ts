import { CoreValidationError } from "@scarn/core/lib/errors";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { normalizeDate } from "./date-utils";
import {
  normalizeWorkItemClosure,
  syncWorkItemClosure,
  type WorkItemClosure,
  type WorkItemClosureProps,
} from "./work-item-close-reason";
import { type WorkItemFields } from "./work-item-field-value";
import {
  createWorkItemId,
  parseWorkItemId,
  type WorkItemId,
} from "./work-item-id";
import type { WorkItemPlatform } from "./work-item-platform";
import type { WorkItemState } from "./work-item-state";

export type WorkItemEntityProps = {
  id: WorkItemId;
  projectId: UuidV7;
  platform: WorkItemPlatform;
  platformId?: string | null | undefined;
  platformKey: string;
  url?: string | null | undefined;
  title: string;
  description?: string | null | undefined;
  // Goes up on every description write; an agent's write names the version
  // it read and is refused when it has moved.
  descriptionVersion?: number | undefined;
  sourceCreatedAt?: Date | string | null | undefined;
  sourceUpdatedAt?: Date | string | null | undefined;
  fields?: WorkItemFields | undefined;
  labels?: readonly string[] | undefined;
  createdByUserId?: UuidV7 | null | undefined;
  assigneeUserId?: UuidV7 | null | undefined;
  // Self-referential parent link for the child/parent work-item hierarchy.
  // `null` means "no parent" (a root item); `undefined` on input is
  // normalized to `null` by the constructor.
  parentWorkItemId?: WorkItemId | null | undefined;
  state?: WorkItemState | undefined;
  // Only for a closed item. A closed item given none gets a sync closure
  // (`completed`, no resolution) dated from the source or the row.
  closure?: WorkItemClosureProps | null | undefined;
  spawnedByTaskId?: UuidV7 | null | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateWorkItemProps = Omit<
  WorkItemEntityProps,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: WorkItemId | undefined;
};

const resolveClosure = (
  props: WorkItemEntityProps,
  state: WorkItemState,
): WorkItemClosure | null => {
  if (state === "open") {
    if (props.closure) {
      throw new CoreValidationError(
        "An open work item can't carry a closure",
        "WORK_ITEM_OPEN_WITH_CLOSURE",
      );
    }
    return null;
  }

  if (props.closure) {
    return normalizeWorkItemClosure(props.closure);
  }

  return syncWorkItemClosure(
    normalizeDate(props.sourceUpdatedAt) ??
      normalizeDate(props.updatedAt) ??
      normalizeDate(props.createdAt) ??
      new Date(),
  );
};

/** Trims each label, drops blanks and duplicates, and keeps case and order. */
export const normalizeWorkItemLabels = (
  labels: readonly string[] | null | undefined,
): string[] => {
  const seen = new Set<string>();
  for (const label of labels ?? []) {
    const trimmed = label.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
};

export class WorkItemEntity {
  public readonly id: WorkItemId;
  public readonly projectId: UuidV7;
  public readonly platform: WorkItemPlatform;
  public readonly platformId: string | null;
  public readonly platformKey: string;
  public readonly url: string | null;
  public readonly title: string;
  public readonly description: string | null;
  public readonly descriptionVersion: number;
  public readonly sourceCreatedAt: Date | null;
  public readonly sourceUpdatedAt: Date | null;
  public readonly fields: WorkItemFields;
  public readonly labels: readonly string[];
  public readonly createdByUserId: UuidV7 | null;
  public readonly assigneeUserId: UuidV7 | null;
  public readonly parentWorkItemId: WorkItemId | null;
  public readonly state: WorkItemState;
  public readonly closure: WorkItemClosure | null;
  public readonly spawnedByTaskId: UuidV7 | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: WorkItemEntityProps) {
    const title = props.title.trim();
    if (!title) {
      throw new CoreValidationError(
        "Work item title is required",
        "WORK_ITEM_TITLE_REQUIRED",
      );
    }

    const platformKey = props.platformKey.trim();
    if (!platformKey) {
      throw new CoreValidationError(
        "Work item platformKey is required",
        "WORK_ITEM_PLATFORM_KEY_REQUIRED",
      );
    }

    this.id = parseWorkItemId(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.platform = props.platform;
    this.platformId = props.platformId?.trim() || null;
    this.platformKey = platformKey;
    this.url = props.url?.trim() || null;
    this.title = title;
    this.description = props.description?.trim() || null;
    this.descriptionVersion = props.descriptionVersion ?? 1;
    this.sourceCreatedAt = normalizeDate(props.sourceCreatedAt) ?? null;
    this.sourceUpdatedAt = normalizeDate(props.sourceUpdatedAt) ?? null;
    this.fields = { ...(props.fields ?? {}) };
    this.labels = normalizeWorkItemLabels(props.labels);
    this.createdByUserId = props.createdByUserId
      ? parseUuidV7(props.createdByUserId)
      : null;
    this.assigneeUserId = props.assigneeUserId
      ? parseUuidV7(props.assigneeUserId)
      : null;
    this.parentWorkItemId = props.parentWorkItemId
      ? parseWorkItemId(props.parentWorkItemId)
      : null;
    this.state = props.state ?? "open";
    this.closure = resolveClosure(props, this.state);
    this.spawnedByTaskId = props.spawnedByTaskId
      ? parseUuidV7(props.spawnedByTaskId)
      : null;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  static create(props: CreateWorkItemProps): WorkItemEntity {
    return new WorkItemEntity({
      ...props,
      id: props.id ?? createWorkItemId(),
    });
  }

  static rehydrate(props: WorkItemEntityProps): WorkItemEntity {
    return new WorkItemEntity(props);
  }

  /**
   * Set or clear this item's parent. Unlike `edit()`, this is allowed
   * regardless of `platform` — parent/child relationships are a Scarn-side
   * organizational concept, not a property of the synced item itself, so
   * externally-synced items can still be organized into a hierarchy.
   */
  setParent(
    parentWorkItemId: WorkItemId | null,
    now: Date = new Date(),
  ): WorkItemEntity {
    if (parentWorkItemId === this.id) {
      throw new CoreValidationError(
        "A work item cannot be its own parent",
        "WORK_ITEM_SELF_PARENT",
      );
    }

    return new WorkItemEntity({
      ...this.toJSON(),
      parentWorkItemId,
      updatedAt: now,
    });
  }

  edit(
    title: string,
    description: string | null,
    now: Date = new Date(),
  ): WorkItemEntity {
    this.assertNative();

    return new WorkItemEntity({
      ...this.toJSON(),
      title,
      description,
      updatedAt: now,
    });
  }

  /**
   * Set or clear the project member responsible for this item. The caller
   * checks that the assignee is a member of the item's project.
   */
  assign(
    assigneeUserId: UuidV7 | null,
    now: Date = new Date(),
  ): WorkItemEntity {
    return new WorkItemEntity({
      ...this.toJSON(),
      assigneeUserId,
      updatedAt: now,
    });
  }

  /**
   * An agent Task's description write. Whether the version the agent read is
   * still current is the repo's compare-and-set (`saveDescription`), not a
   * check against this possibly stale copy.
   */
  describeByTask(
    description: string | null,
    now: Date = new Date(),
  ): WorkItemEntity {
    this.assertNative();

    return new WorkItemEntity({
      ...this.toJSON(),
      description,
      updatedAt: now,
    });
  }

  /** Adds labels to a native item; labels it already has are kept once. */
  addLabels(labels: readonly string[], now: Date = new Date()): WorkItemEntity {
    this.assertNative();

    return new WorkItemEntity({
      ...this.toJSON(),
      labels: [...this.labels, ...labels],
      updatedAt: now,
    });
  }

  /** Removes labels from a native item, matching the trimmed name exactly. */
  removeLabels(
    labels: readonly string[],
    now: Date = new Date(),
  ): WorkItemEntity {
    this.assertNative();

    const removed = new Set(normalizeWorkItemLabels(labels));
    return new WorkItemEntity({
      ...this.toJSON(),
      labels: this.labels.filter((label) => !removed.has(label)),
      updatedAt: now,
    });
  }

  private assertNative(): void {
    if (this.platform !== "scarn") {
      throw new CoreValidationError(
        "Only work items created natively on Scarn can be edited",
        "WORK_ITEM_NOT_EDITABLE_SYNCED",
      );
    }
  }

  close(closure: WorkItemClosure, now: Date = new Date()): WorkItemEntity {
    if (this.state === "closed") {
      throw new CoreValidationError(
        "Work item is already closed",
        "WORK_ITEM_ALREADY_CLOSED",
      );
    }

    return new WorkItemEntity({
      ...this.toJSON(),
      state: "closed",
      closure,
      updatedAt: now,
    });
  }

  reopen(now: Date = new Date()): WorkItemEntity {
    if (this.state === "open") {
      throw new CoreValidationError(
        "Work item is already open",
        "WORK_ITEM_ALREADY_OPEN",
      );
    }

    return new WorkItemEntity({
      ...this.toJSON(),
      state: "open",
      closure: null,
      updatedAt: now,
    });
  }

  toJSON(): WorkItemEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      platform: this.platform,
      platformId: this.platformId,
      platformKey: this.platformKey,
      url: this.url,
      title: this.title,
      description: this.description,
      descriptionVersion: this.descriptionVersion,
      sourceCreatedAt: this.sourceCreatedAt,
      sourceUpdatedAt: this.sourceUpdatedAt,
      fields: { ...this.fields },
      labels: [...this.labels],
      createdByUserId: this.createdByUserId,
      assigneeUserId: this.assigneeUserId,
      parentWorkItemId: this.parentWorkItemId,
      state: this.state,
      closure: this.closure ? { ...this.closure } : null,
      spawnedByTaskId: this.spawnedByTaskId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
