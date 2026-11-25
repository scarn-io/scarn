import { z } from "zod";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { createTolerantReader } from "@scarn/core/lib/db/stored-json";

/**
 * Read-side schema for `user_notifications.payload_json`. Tolerant, not
 * versioned: notifications are short-lived, and the renderer falls back on
 * a payload it doesn't recognise.
 *
 * The column is a JSON object or null. Each notification kind writes its
 * own keys (`conversationId`, `questionId`, auto-sync `integrationId` /
 * `reason` / `detail`, the task result's payload and `commentSuppressed`,
 * and `response` once answered). The one key read in SQL is
 * `payload_json ->> 'conversationId'` (`deleteByTaskOrConversation` in
 * `drizzle-user-notification-repo.ts`), so it is pinned as a string when
 * present. Every other key is kept as-is.
 *
 * Structural only and frozen here. See `docs/persistence/json-columns.md`.
 */
const storedUserNotificationPayloadSchema = z
  .looseObject({ conversationId: z.string().optional() })
  .pipe(z.record(z.string(), z.json()))
  .nullable();

/** Reads a notification's `payload_json`, or explains why it is unreadable. */
export const readStoredUserNotificationPayload =
  createTolerantReader<AnyJsonObject | null>(
    storedUserNotificationPayloadSchema,
  );

/**
 * The payload with `additions` set over it. The stored keys are read
 * through {@link readStoredUserNotificationPayload}; an unreadable payload
 * keeps none of them.
 */
export const withStoredUserNotificationPayloadKeys = (
  payload: AnyJsonObject | null,
  additions: AnyJsonObject,
): AnyJsonObject => {
  const read = readStoredUserNotificationPayload(payload);
  return { ...(read.success ? read.value : null), ...additions };
};
