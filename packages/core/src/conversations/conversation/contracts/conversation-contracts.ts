import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";
import {
  taskRunReasonValues,
  taskRunStatusValues,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { conversationStatusValues } from "../domain/conversation-entity";
import { repoConversationStateValues } from "../domain/repo-conversation-state";
import {
  CONVERSATION_MESSAGE_BODY_MAX_LENGTH,
  conversationMessageAuthorKindValues,
} from "../domain/conversation-message-entity";

export const conversationIdParamsSchema = z.object({
  conversationId: uuidV7Schema,
});

export const conversationMessageSchema = z.object({
  id: uuidV7Schema,
  authorKind: z.enum(conversationMessageAuthorKindValues),
  /** The person's username; null for an agent message or an unknown user. */
  authorName: z.string().nullable(),
  /** The attempt that wrote an agent message. */
  taskRunId: uuidV7Schema.nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});

/** The step visit a conversation belongs to. */
export const conversationVisitSchema = z.object({
  pipelineExecutionId: uuidV7Schema,
  visitId: uuidV7Schema,
  nodeId: z.string(),
});

/** What the viewer may do to a chat, by permission alone (not its state). */
export const conversationCapabilitiesSchema = z.object({
  canReply: z.boolean(),
  canRetry: z.boolean(),
  canEnd: z.boolean(),
  canDelete: z.boolean(),
});

/** Who started a chat; username and image are null when unknown. */
export const conversationCreatorSchema = z.object({
  userId: uuidV7Schema,
  username: z.string().nullable(),
  image: z.string().nullable(),
});

/**
 * The repo a chat asks about. `branch` and `commit` are pinned by the first
 * run a worker started; both are null before that. `pinnedAt` is when that
 * run started.
 */
export const conversationContextSchema = z.object({
  kind: z.literal("project_repo"),
  repository: z.string(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  pinnedAt: z.iso.datetime().nullable(),
});

/** A failed turn's error: a stable code and a fixed message, never the raw text. */
export const conversationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const conversationLatestRunSchema = z.object({
  id: uuidV7Schema,
  status: z.enum(taskRunStatusValues),
  reason: z.enum(taskRunReasonValues),
});

export const conversationSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  workItemId: uuidV7Schema.nullable(),
  status: z.enum(conversationStatusValues),
  /** Oldest first. */
  messages: z.array(conversationMessageSchema),
  visit: conversationVisitSchema.nullable(),
  /**
   * How the step ends: `findings` for a step with a result schema,
   * `conversation` for a conversation step; null with no visit.
   */
  endsWith: z.enum(["findings", "conversation"]).nullable(),
  createdAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** Chats only (and only on `getConversation` and the chat routes): the chat's Task. */
  taskId: uuidV7Schema.optional(),
  /** Chats only. Null when the Task has no starter. */
  creator: conversationCreatorSchema.nullable().optional(),
  /** Chats only. */
  context: conversationContextSchema.optional(),
  /** Chats only: the derived state (see `repoConversationState`). */
  state: z.enum(repoConversationStateValues).optional(),
  /** Chats only. Null before the first run. */
  latestRun: conversationLatestRunSchema.nullable().optional(),
  /** Chats only: the latest run's error, when it failed. */
  error: conversationErrorSchema.nullable().optional(),
  /** Chats only: what the viewer may do; all false for an anonymous viewer. */
  capabilities: conversationCapabilitiesSchema.optional(),
});

export const sendConversationMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(CONVERSATION_MESSAGE_BODY_MAX_LENGTH),
});

export const sendConversationMessageInputSchema =
  sendConversationMessageBodySchema.extend({ conversationId: uuidV7Schema });

export const workItemConversationSchema = z.object({
  id: uuidV7Schema,
  status: z.enum(conversationStatusValues),
  /** The node of the step visit it belongs to; null with no visit. */
  nodeId: z.string().nullable(),
  pipelineExecutionId: uuidV7Schema.nullable(),
  visitId: uuidV7Schema.nullable(),
  lastMessageAt: z.iso.datetime().nullable(),
  /** Oldest first. */
  messages: z.array(conversationMessageSchema),
  createdAt: z.iso.datetime(),
});

/** A person's first question, opening a repo conversation on the project. */
export const createRepoConversationInputSchema =
  sendConversationMessageBodySchema.extend({ projectId: uuidV7Schema });

export const createdRepoConversationSchema = z.object({
  conversationId: uuidV7Schema,
  taskId: uuidV7Schema,
  taskRunId: uuidV7Schema,
});

/** Opening a chat takes the question only: no branch, commit, grants or work item. */
export const createRepoConversationBodySchema =
  sendConversationMessageBodySchema.pick({ body: true }).strict();

export const retryRepoConversationBodySchema = z
  .object({ expectedLatestRunId: uuidV7Schema.nullable() })
  .strict();

export const retryRepoConversationInputSchema =
  retryRepoConversationBodySchema.extend({ conversationId: uuidV7Schema });

export const DEFAULT_PROJECT_CONVERSATIONS_LIMIT = 50;
export const MAX_PROJECT_CONVERSATIONS_LIMIT = 200;

export const listProjectConversationsQuerySchema = z.object({
  /** The last chat of the previous page (its `nextCursor`). */
  before: uuidV7Schema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PROJECT_CONVERSATIONS_LIMIT)
    .optional(),
});

export const projectConversationSummarySchema = z.object({
  id: uuidV7Schema,
  taskId: uuidV7Schema,
  /** The first message, whitespace collapsed, at most 140 characters. */
  preview: z.string(),
  creator: conversationCreatorSchema.nullable(),
  state: z.enum(repoConversationStateValues),
  /** The newest message, or the newest run's completion, start or queueing. */
  lastActivityAt: z.iso.datetime(),
  /** The pinned commit's first 12 characters; null before it is pinned. */
  shortCommit: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const projectConversationsPageSchema = z.object({
  /** Newest first. */
  conversations: z.array(projectConversationSummarySchema),
  /** Pass as `before` for the next page; `null` on the last page. */
  nextCursor: uuidV7Schema.nullable(),
});

export type CreateRepoConversationInput = z.input<
  typeof createRepoConversationInputSchema
>;
export type CreatedRepoConversationContract = z.infer<
  typeof createdRepoConversationSchema
>;
export type ConversationCapabilities = z.infer<
  typeof conversationCapabilitiesSchema
>;
export type ConversationContract = z.infer<typeof conversationSchema>;
export type ConversationCreatorContract = z.infer<
  typeof conversationCreatorSchema
>;
export type ConversationContextContract = z.infer<
  typeof conversationContextSchema
>;
export type ConversationErrorContract = z.infer<typeof conversationErrorSchema>;
export type ConversationLatestRunContract = z.infer<
  typeof conversationLatestRunSchema
>;
export type CreateRepoConversationBody = z.input<
  typeof createRepoConversationBodySchema
>;
export type RetryRepoConversationBody = z.input<
  typeof retryRepoConversationBodySchema
>;
export type ListProjectConversationsQueryInput = z.input<
  typeof listProjectConversationsQuerySchema
>;
export type ProjectConversationSummaryContract = z.infer<
  typeof projectConversationSummarySchema
>;
export type ProjectConversationsPageContract = z.infer<
  typeof projectConversationsPageSchema
>;
export type RetryRepoConversationInput = z.input<
  typeof retryRepoConversationInputSchema
>;
export type ConversationMessageContract = z.infer<
  typeof conversationMessageSchema
>;
export type ConversationVisitContract = z.infer<typeof conversationVisitSchema>;
export type SendConversationMessageBody = z.input<
  typeof sendConversationMessageBodySchema
>;
export type SendConversationMessageInput = z.input<
  typeof sendConversationMessageInputSchema
>;
export type WorkItemConversationContract = z.infer<
  typeof workItemConversationSchema
>;
