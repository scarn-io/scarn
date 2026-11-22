import { inArray } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  UserDisplay,
  UsernameReader,
} from "../application/username-reader";
import { identityUsers } from "./identity-org-read-model";

/**
 * Resolves usernames from the identity-owned `user` table (cross-schema read
 * model). One `WHERE id IN (...)` per call keeps author/owner resolution to a
 * single round-trip regardless of how many distinct users a page references.
 */
export class DrizzleUsernameReader implements UsernameReader {
  async loadUsernamesByUserId(
    userIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<Map<UuidV7, UserDisplay>> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) {
      return new Map<UuidV7, UserDisplay>();
    }

    const db = dbExecutor ?? getDb();
    const rows = await db
      .select({
        id: identityUsers.id,
        username: identityUsers.username,
        image: identityUsers.image,
      })
      .from(identityUsers)
      .where(inArray(identityUsers.id, uniqueIds));

    return new Map(
      rows.map((row) => [
        row.id as UuidV7,
        { username: row.username, image: row.image },
      ]),
    );
  }
}
