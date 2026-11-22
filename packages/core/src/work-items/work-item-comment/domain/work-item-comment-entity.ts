import { CoreValidationError } from "@scarn/core/lib/errors";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { normalizeDate } from "./date-utils";
import {
  createWorkItemCommentId,
  parseWorkItemCommentId,
  type WorkItemCommentId,
} from "./work-item-comment-id";

export type WorkItemCommentAuthorKind = "user" | "agent";

export type WorkItemCommentEntityProps = {
  id: WorkItemCommentId;
  projectId: UuidV7;
  workItemId: UuidV7;
  // Required for `authorKind: "user"` rows; must be null/undefined for
  // `authorKind: "agent"` rows (a promoted comment_draft has no
  // project-member author) — enforced in the constructor.
  authorUserId?: UuidV7 | null | undefined;
  authorKind?: WorkItemCommentAuthorKind | undefined;
  // Set only on `agent`-authored rows: the pipeline agent session that
  // drafted the originating notification.
  agentSessionId?: UuidV7 | null | undefined;
  // Traceability back to the `comment_draft` notification this comment was
  // promoted from, once approved.
  sourceNotificationId?: UuidV7 | null | undefined;
  // GitHub's comment id/`html_url` once posted, mirroring
  // `notificationDeliveries.externalId`/`externalUrl`.
  externalCommentId?: string | null | undefined;
  externalCommentUrl?: string | null | undefined;
  // Set only on `agent` rows an agent Task posted itself.
  authoredByTaskId?: UuidV7 | null | undefined;
  // The top-level comment this one replies to; null for top-level comments.
  parentCommentId?: WorkItemCommentId | null | undefined;
  body: string;
  isPinned?: boolean | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateWorkItemCommentProps = Omit<
  WorkItemCommentEntityProps,
  "id" | "createdAt" | "updatedAt" | "authorUserId" | "authorKind"
> & {
  id?: WorkItemCommentId | undefined;
  authorUserId: UuidV7;
};

export type CreateWorkItemCommentFromApprovedDraftProps = {
  id?: WorkItemCommentId | undefined;
  projectId: UuidV7;
  workItemId: UuidV7;
  agentSessionId?: UuidV7 | null | undefined;
  sourceNotificationId: UuidV7;
  body: string;
  externalCommentId: string | null;
  externalCommentUrl: string | null;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreateAgentQuestionCommentProps = {
  id?: WorkItemCommentId | undefined;
  projectId: UuidV7;
  workItemId: UuidV7;
  body: string;
  createdAt: Date;
  /** The agent Task that posted the comment itself, if any. */
  authoredByTaskId?: UuidV7 | null | undefined;
};

export class WorkItemCommentEntity {
  public readonly id: WorkItemCommentId;
  public readonly projectId: UuidV7;
  public readonly workItemId: UuidV7;
  public readonly authorUserId: UuidV7 | null;
  public readonly authorKind: WorkItemCommentAuthorKind;
  public readonly agentSessionId: UuidV7 | null;
  public readonly sourceNotificationId: UuidV7 | null;
  public readonly externalCommentId: string | null;
  public readonly externalCommentUrl: string | null;
  public readonly authoredByTaskId: UuidV7 | null;
  public readonly parentCommentId: WorkItemCommentId | null;
  public readonly body: string;
  public readonly isPinned: boolean;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: WorkItemCommentEntityProps) {
    const body = props.body.trim();
    if (!body) {
      throw new CoreValidationError(
        "Comment body is required",
        "WORK_ITEM_COMMENT_BODY_REQUIRED",
      );
    }

    const authorKind = props.authorKind ?? "user";
    let authorUserId: UuidV7 | null;
    if (authorKind === "agent") {
      if (props.authorUserId !== null && props.authorUserId !== undefined) {
        throw new CoreValidationError(
          "Agent-authored comments must not have an author user id",
          "WORK_ITEM_COMMENT_AUTHOR_MISMATCH",
        );
      }
      authorUserId = null;
    } else {
      if (props.authorUserId === null || props.authorUserId === undefined) {
        throw new CoreValidationError(
          "User-authored comments require an author user id",
          "WORK_ITEM_COMMENT_AUTHOR_MISMATCH",
        );
      }
      authorUserId = parseUuidV7(props.authorUserId);
    }

    this.id = parseWorkItemCommentId(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.workItemId = parseUuidV7(props.workItemId);
    this.authorUserId = authorUserId;
    this.authorKind = authorKind;
    this.agentSessionId = props.agentSessionId
      ? parseUuidV7(props.agentSessionId)
      : null;
    this.sourceNotificationId = props.sourceNotificationId
      ? parseUuidV7(props.sourceNotificationId)
      : null;
    this.externalCommentId = props.externalCommentId ?? null;
    this.externalCommentUrl = props.externalCommentUrl ?? null;
    if (authorKind === "user" && props.authoredByTaskId) {
      throw new CoreValidationError(
        "User-authored comments must not have an authoring task",
        "WORK_ITEM_COMMENT_AUTHOR_MISMATCH",
      );
    }
    this.authoredByTaskId = props.authoredByTaskId
      ? parseUuidV7(props.authoredByTaskId)
      : null;
    this.parentCommentId = props.parentCommentId
      ? parseWorkItemCommentId(props.parentCommentId)
      : null;
    this.body = body;
    this.isPinned = props.isPinned ?? false;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  static create(props: CreateWorkItemCommentProps): WorkItemCommentEntity {
    return new WorkItemCommentEntity({
      ...props,
      id: props.id ?? createWorkItemCommentId(),
      authorKind: "user",
      isPinned: props.isPinned ?? false,
    });
  }

  static createFromApprovedDraft(
    props: CreateWorkItemCommentFromApprovedDraftProps,
  ): WorkItemCommentEntity {
    return new WorkItemCommentEntity({
      id: props.id ?? createWorkItemCommentId(),
      projectId: props.projectId,
      workItemId: props.workItemId,
      authorUserId: null,
      authorKind: "agent",
      agentSessionId: props.agentSessionId,
      sourceNotificationId: props.sourceNotificationId,
      externalCommentId: props.externalCommentId,
      externalCommentUrl: props.externalCommentUrl,
      body: props.body,
      isPinned: false,
      createdAt: props.createdAt,
      updatedAt: props.updatedAt,
    });
  }

  /** A question the pipeline engine asks on the work item; agent-authored. */
  static createAgentQuestion(
    props: CreateAgentQuestionCommentProps,
  ): WorkItemCommentEntity {
    return WorkItemCommentEntity.createAgentComment(props);
  }

  /**
   * A comment Scarn posts itself, with no author user, session or source
   * notification: an engine question, or an agent Task's comment, close
   * resolution or summary (`authoredByTaskId` that Task).
   */
  static createAgentComment(
    props: CreateAgentQuestionCommentProps,
  ): WorkItemCommentEntity {
    return new WorkItemCommentEntity({
      id: props.id ?? createWorkItemCommentId(),
      projectId: props.projectId,
      workItemId: props.workItemId,
      authorUserId: null,
      authorKind: "agent",
      agentSessionId: null,
      sourceNotificationId: null,
      externalCommentId: null,
      externalCommentUrl: null,
      authoredByTaskId: props.authoredByTaskId ?? null,
      parentCommentId: null,
      body: props.body,
      isPinned: false,
      createdAt: props.createdAt,
      updatedAt: props.createdAt,
    });
  }

  /**
   * Replies are one level deep: `parent` must exist, be a top-level comment
   * and belong to `workItemId`.
   */
  static assertValidParent(
    parent: WorkItemCommentEntity | null,
    workItemId: string,
  ): asserts parent is WorkItemCommentEntity {
    if (
      !parent ||
      parent.parentCommentId !== null ||
      parent.workItemId !== workItemId
    ) {
      throw new CoreValidationError(
        "A reply's parent must be a top-level comment on the same work item",
        "WORK_ITEM_COMMENT_PARENT_INVALID",
      );
    }
  }

  static rehydrate(props: WorkItemCommentEntityProps): WorkItemCommentEntity {
    return new WorkItemCommentEntity(props);
  }

  edit(body: string, now: Date = new Date()): WorkItemCommentEntity {
    return new WorkItemCommentEntity({
      ...this.toJSON(),
      body,
      updatedAt: now,
    });
  }

  setPinned(isPinned: boolean, now: Date = new Date()): WorkItemCommentEntity {
    return new WorkItemCommentEntity({
      ...this.toJSON(),
      isPinned,
      updatedAt: now,
    });
  }

  pin(now: Date = new Date()): WorkItemCommentEntity {
    return this.setPinned(true, now);
  }

  unpin(now: Date = new Date()): WorkItemCommentEntity {
    return this.setPinned(false, now);
  }

  toJSON(): WorkItemCommentEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      workItemId: this.workItemId,
      authorUserId: this.authorUserId,
      authorKind: this.authorKind,
      agentSessionId: this.agentSessionId,
      sourceNotificationId: this.sourceNotificationId,
      externalCommentId: this.externalCommentId,
      externalCommentUrl: this.externalCommentUrl,
      authoredByTaskId: this.authoredByTaskId,
      parentCommentId: this.parentCommentId,
      body: this.body,
      isPinned: this.isPinned,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
