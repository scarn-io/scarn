import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { z } from "zod";

/**
 * The source that produced a log line. `worker` is the host worker's structured
 * pino diagnostics; `ai-server` is the in-container OpenCode AI server's
 * stdout/stderr; `conversation` carries structured agent-conversation events
 * (model text, reasoning, tool calls) serialized as JSON in `content` — see
 * `ConversationEvent` in the worker. These render as a chat transcript in the
 * UI rather than as flat log rows.
 *
 * The `worker` and `ai-server` streams are level-filtered on the worker before
 * shipping (see `TaskLogShipper`): low-signal lines (e.g. heartbeat
 * ticks, verbose AI-server output) are logged locally but kept out of the
 * durable feed/archive. The `conversation` stream is product data and is always
 * shipped.
 */
export const taskLogStreamValues = [
  "worker",
  "ai-server",
  "conversation",
] as const;
export const taskLogStreamSchema = z.enum(taskLogStreamValues);
export type TaskLogStream = z.infer<typeof taskLogStreamSchema>;

/**
 * Structured severity of a log line, produced at the source (worker) and
 * persisted through the feed and archive so consumers never have to guess
 * severity from the message text. The `conversation` stream is product data and
 * is always emitted at `info`.
 */
export const logLevelValues = ["debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(logLevelValues);
export type LogLevelContract = z.infer<typeof logLevelSchema>;

const MAX_LINE_CONTENT_LENGTH = 16_000;
const MAX_BATCH_LINES = 1_000;

/**
 * A single log line as emitted by the worker. `seq` is a monotonic, per
 * task offset cursor (GitHub-Actions-style): clients read "everything
 * after seq N" and the unique (task_run_id, seq) constraint makes appends
 * idempotent across retries.
 */
export const appendLogLineSchema = z.object({
  seq: z.number().int().nonnegative(),
  stream: taskLogStreamSchema,
  ts: z.iso.datetime(),
  content: z.string().max(MAX_LINE_CONTENT_LENGTH),
  level: logLevelSchema,
});
export type AppendLogLineInput = z.infer<typeof appendLogLineSchema>;

export const appendTaskLogsInputSchema = z.object({
  claimToken: z.string().trim().min(1),
  lines: z.array(appendLogLineSchema).min(1).max(MAX_BATCH_LINES),
});
export type AppendTaskLogsInput = z.infer<typeof appendTaskLogsInputSchema>;

export const appendTaskLogsResultSchema = z.object({
  /** Highest seq the feed has durably stored for this task. */
  nextOffset: z.number().int().nonnegative(),
});
export type AppendTaskLogsResult = z.infer<typeof appendTaskLogsResultSchema>;

export const logLineSchema = z.object({
  seq: z.number().int().nonnegative(),
  stream: taskLogStreamSchema,
  ts: z.iso.datetime(),
  content: z.string(),
  level: logLevelSchema,
});
export type LogLineContract = z.infer<typeof logLineSchema>;

/**
 * Structured projection of an OpenCode agent conversation, emitted by the
 * worker on the `conversation` stream (one event per log line, JSON-encoded in
 * `content`). This is a render-ready subset of OpenCode's `Message`/`Part`
 * types so the browser never needs to depend on the OpenCode SDK. Parts carry a
 * stable `partId`; because OpenCode resends the full part on every update, the
 * UI upserts by `partId` to get live streaming text and tool-status updates.
 */
export const conversationRoleSchema = z.enum(["user", "assistant"]);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

export const conversationToolStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "error",
]);
export type ConversationToolStatus = z.infer<
  typeof conversationToolStatusSchema
>;

export const conversationEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: z.string(),
    role: conversationRoleSchema,
    modelID: z.string().optional(),
    createdMs: z.number(),
  }),
  z.object({
    kind: z.literal("text"),
    messageId: z.string(),
    partId: z.string(),
    role: conversationRoleSchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("reasoning"),
    messageId: z.string(),
    partId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("tool"),
    messageId: z.string(),
    partId: z.string(),
    callId: z.string(),
    tool: z.string(),
    status: conversationToolStatusSchema,
    title: z.string().optional(),
    input: z.unknown().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("step-finish"),
    messageId: z.string(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
    }),
  }),
  z.object({
    kind: z.literal("session-error"),
    message: z.string(),
  }),
]);
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export const readTaskLogsQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(2_000).default(1_000),
});
export type ReadTaskLogsQuery = z.infer<typeof readTaskLogsQuerySchema>;

export const readTaskLogsResultSchema = z.object({
  lines: z.array(logLineSchema),
  /** Cursor to pass as `from` on the next poll. */
  nextOffset: z.number().int().nonnegative(),
  /**
   * True once the task is terminal AND its live feed has been flushed
   * to the durable archive. When true the UI should stop polling the feed and
   * read the archive instead.
   */
  complete: z.boolean(),
});
export type ReadTaskLogsResult = z.infer<typeof readTaskLogsResultSchema>;

export const taskLogArchiveSchema = z.object({
  /**
   * A presigned URL the browser can fetch directly, when the object store
   * supports presigning. Null means the caller should read the archive bytes
   * via the API proxy endpoint instead.
   */
  url: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
});
export type TaskLogArchiveContract = z.infer<typeof taskLogArchiveSchema>;

export const taskIdInputSchema = uuidV7Schema;
