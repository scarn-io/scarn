import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read-model handles for the better-auth `organization` plugin tables, which
 * physically live in the `identity` schema and are owned + migrated by
 * `@scarn/identity`.
 *
 * These are declared OUTSIDE `packages/core/src/lib/db/schema.ts` on purpose:
 * that file is the source schema for this package's `drizzle-kit` config, so
 * anything declared there would be (incorrectly) emitted as a CREATE TABLE in
 * core migrations. Keeping these here gives `OrgRepo` typed table handles to
 * `select()`/`insert()` over the shared connection without making core's
 * migrations responsible for identity-owned tables, and without importing the
 * identity package (matching the cross-schema-by-uuid convention).
 *
 * Column shapes mirror `@scarn/identity` `db/schema.ts`. If those change, keep
 * this read model in sync.
 */
const identitySchema = pgSchema("identity");

export const identityOrganizations = identitySchema.table("organization", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const identityOrganizationMembers = identitySchema.table("member", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Read-model handle for the better-auth `user` table (identity schema, owned +
 * migrated by `@scarn/identity`). Only the columns core needs to resolve a
 * username to its user id for pretty-URL routing are declared. Keep in sync
 * with `@scarn/identity` `db/schema.ts` `authUsers`.
 */
export const identityUsers = identitySchema.table("user", {
  id: uuid("id").primaryKey(),
  // Nullable, mirroring `@scarn/identity` `authUsers.username`: OAuth/social
  // signups start with NULL until they pick a handle during onboarding.
  username: text("username"),
  image: text("image"),
});
