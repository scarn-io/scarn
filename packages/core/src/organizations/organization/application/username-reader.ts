import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * A user's read-time display fields resolved from their id: the user-facing
 * `username` handle and their avatar `image` URL. Both are nullable, mirroring
 * the identity-owned `user` table (username is NULL until onboarding; image is
 * optional).
 */
export type UserDisplay = {
  username: string | null;
  image: string | null;
};

/**
 * Read-time resolver from a user's id to their display fields (`username` +
 * `image`). Usernames are the user-facing identity label everywhere in the app;
 * ids are the identity of record (decision D4). Consumers hold only `userId`s
 * (on comments, projects, org ownership) and resolve display fields through this
 * reader at read time — they are never persisted onto those rows.
 *
 * Reads the identity-owned `user` table via the cross-schema read model, so it
 * lives here in core without importing `@scarn/identity`.
 */
export type UsernameReader = {
  /**
   * Batch-resolve a set of user ids to their display fields. The returned map
   * only contains ids that resolved to a row; unknown ids are omitted so callers
   * can decide their own fallback. De-duplicates ids before querying.
   */
  loadUsernamesByUserId(
    userIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, UserDisplay>>;
};
