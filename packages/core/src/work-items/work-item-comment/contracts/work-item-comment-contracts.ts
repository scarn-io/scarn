import { z } from "zod";
import {
  isWorkItemCommentId,
  type WorkItemCommentId,
} from "../domain/work-item-comment-id";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { workItemIdSchema } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";

export const workItemCommentIdSchema = z
  .string()
  .trim()
  .refine(isWorkItemCommentId, {
    message: "Work item comment id must be a UUID v7",
  }) as z.ZodType<WorkItemCommentId>;

export const workItemCommentSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema,
  // `null` for `authorKind: "agent"` rows (a promoted comment_draft has no
  // project-member author).
  authorUserId: uuidV7Schema.nullable(),
  authorKind: z.enum(["user", "agent"]),
  // Set only on `agent`-authored rows: the pipeline agent session that
  // drafted the originating notification.
  agentSessionId: uuidV7Schema.nullable(),
  // Traceability back to the `comment_draft` notification this comment was
  // promoted from, once approved.
  sourceNotificationId: uuidV7Schema.nullable(),
  // GitHub's comment id/`html_url` once posted, mirroring
  // `notificationDeliveries.externalId`/`externalUrl`.
  externalCommentId: z.string().nullable(),
  externalCommentUrl: z.string().nullable(),
  // Set only on `agent` rows an agent Task posted itself; `null` once that
  // Task is deleted.
  authoredByTaskId: uuidV7Schema.nullable(),
  // Read-time display label resolved from `authoredByTaskId`: the Task's
  // name, else its step's, else "Agent". Never persisted on the comment.
  // `null` when there is no authoring Task; consumers fall back to a generic
  // label.
  authorName: z.string().nullable(),
  // The top-level comment this one replies to; null for top-level comments.
  parentCommentId: uuidV7Schema.nullable(),
  // Read-time display label resolved from `authorUserId` → identity `username`
  // (decision D4: the id stays the identity of record; the username is never
  // persisted on the comment). `null` when the author id has no resolvable
  // username (e.g. a deleted user, or an agent-authored comment with no
  // author to resolve); consumers fall back to a generic label.
  authorUsername: z.string().trim().min(1).nullable(),
  // Read-time avatar URL resolved from `authorUserId` → identity `image`
  // alongside `authorUsername`. `null` when the user has no image or is
  // deleted; consumers fall back to a generic avatar.
  authorImage: z.string().nullable(),
  body: z.string().trim().min(1),
  isPinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createWorkItemCommentInputSchema = z.object({
  workItemId: workItemIdSchema,
  body: z.string().trim().min(1),
  parentCommentId: workItemCommentIdSchema.optional(),
});

export const editWorkItemCommentInputSchema = z.object({
  commentId: workItemCommentIdSchema,
  body: z.string().trim().min(1),
});

export const setWorkItemCommentPinInputSchema = z.object({
  commentId: workItemCommentIdSchema,
  isPinned: z.boolean(),
});

export const listWorkItemCommentsInputSchema = workItemIdSchema;

export const deleteWorkItemCommentInputSchema = workItemCommentIdSchema;

export type WorkItemCommentContract = z.infer<typeof workItemCommentSchema>;
export type CreateWorkItemCommentInput = z.input<
  typeof createWorkItemCommentInputSchema
>;
export type CreateWorkItemCommentParsed = z.infer<
  typeof createWorkItemCommentInputSchema
>;
export type EditWorkItemCommentInput = z.input<
  typeof editWorkItemCommentInputSchema
>;
export type SetWorkItemCommentPinInput = z.input<
  typeof setWorkItemCommentPinInputSchema
>;
export type ListWorkItemCommentsInput = z.input<
  typeof listWorkItemCommentsInputSchema
>;
export type DeleteWorkItemCommentInput = z.input<
  typeof deleteWorkItemCommentInputSchema
>;

export type PinnedWorkItemCommentForAgent = {
  createdAt: string;
  body: string;
};
