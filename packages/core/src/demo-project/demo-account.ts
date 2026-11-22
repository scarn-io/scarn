import {
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";

/**
 * The identity that owns the singleton public demo project (issue #151).
 *
 * Unlike `SYSTEM_ACTOR_ID`/`ANONYMOUS_ACTOR_ID` in
 * `@scarn/core/access/authorization`, this is not a synthetic actor with
 * special authorization treatment — it is an ordinary account (a real
 * personal org, a real owner membership on its project, the same permission
 * set any signed-up user gets on a project they create) that happens to be
 * provisioned by a seed script instead of sign-up. It needs a fixed id
 * because the seed script must be safe to re-run without duplicating data,
 * and a fixed, real `username` because the demo project's URL
 * (`/{username}/{slug}`) must stay stable for other tickets (#153, #154) to
 * link to.
 *
 * The corresponding `identity.user` row — including its `username`, which
 * `DrizzleAuthUserRepo.save` deliberately never overwrites once set — is
 * created by the data migration in
 * `packages/identity/drizzle/0001_seed_synthetic_users.sql`. This constant is
 * a fixed, hand-picked literal — it does not need to be time-derived, only a
 * syntactically valid UUID v7 (version nibble `7`, variant nibble in
 * `{8,9,a,b}`) — mirroring `SYSTEM_ACTOR_ID`/`ANONYMOUS_ACTOR_ID`.
 */
export const DEMO_ACCOUNT_USER_ID: UuidV7 = parseUuidV7(
  "01977e00-0000-7000-8000-000000000003",
);

/**
 * Must match the `username` column set by
 * `0001_seed_synthetic_users.sql`, and must never appear in
 * `RESERVED_USERNAMES` (`packages/identity/src/authentication/contracts/auth-contracts.ts`)
 * — it was removed from that set specifically so the demo account could claim
 * it.
 */
export const DEMO_ACCOUNT_USERNAME = "scarn";

/** Must match the `name` column set by `0001_seed_synthetic_users.sql`. */
export const DEMO_ACCOUNT_NAME = "Scarn Demo";

/**
 * The demo project's fixed name. `slugify(DEMO_PROJECT_NAME)` must equal
 * `DEMO_PROJECT_SLUG` below — the seed script relies on that to land on a
 * predictable slug the very first time it creates the project (see
 * `ensureDemoAccountAndProject`).
 */
export const DEMO_PROJECT_NAME = "Demo";

/**
 * The demo project's fixed, human-chosen slug within the demo account's
 * personal org. Combined with `DEMO_ACCOUNT_USERNAME`, this is the demo
 * project's stable, predictable URL: `/scarn/demo`.
 */
export const DEMO_PROJECT_SLUG = "demo";
