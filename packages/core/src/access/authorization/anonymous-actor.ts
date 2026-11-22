import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * The identity used for HTTP requests that carry no session at all (e.g. a
 * logged-out visitor reading a public project). Mirrors `SYSTEM_ACTOR_ID`:
 * it is never a real human user, is never a project member, and is only
 * ever granted access via `ProjectEntity.visibility === "public"` fallback
 * in `assertProjectPermission` — never via an explicit membership row.
 *
 * Kept as a stable, real `identity.user` row (created by the migration in
 * `packages/identity/drizzle/0001_seed_synthetic_users.sql`) rather than a
 * nullable actor id, so no existing use case, ownership check, or write path
 * needs to special-case "no user" — they just see an actor that is never a
 * member and is denied with 401 (not 403) when the fallback doesn't apply.
 *
 * This is a fixed, hand-picked literal — it does not need to be
 * time-derived, only a syntactically valid UUID v7 (version nibble `7`,
 * variant nibble in `{8,9,a,b}`).
 */
export const ANONYMOUS_ACTOR_ID: UuidV7 = parseUuidV7(
  "01977e00-0000-7000-8000-000000000002",
);
