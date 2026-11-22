import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * The identity used for unattended, system-initiated actions (e.g. scheduled
 * reconciliation runs) that have no human actor to attribute the change to.
 *
 * The corresponding `identity.user` row is created by the data migration in
 * `packages/identity/drizzle/0001_seed_synthetic_users.sql`. This constant is a
 * fixed, hand-picked literal — it does not need to be time-derived, only a
 * syntactically valid UUID v7 (version nibble `7`, variant nibble in
 * `{8,9,a,b}`).
 */
export const SYSTEM_ACTOR_ID: UuidV7 = parseUuidV7(
  "01977e00-0000-7000-8000-000000000001",
);
