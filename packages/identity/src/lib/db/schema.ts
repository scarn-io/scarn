import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createAuthId } from "../../authentication/domain/auth-id";

export const identitySchema = pgSchema("identity");

const createdAtColumn = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

const updatedAtColumn = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

const authIdColumn = (name: string) => uuid(name).$defaultFn(createAuthId);

export const authUsers = identitySchema.table(
  "user",
  {
    id: authIdColumn("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    // Nullable: every user (including OAuth/social signups) chooses their own
    // handle during onboarding. Better Auth's Drizzle adapter creates the OAuth
    // user row BEFORE the user picks a username, so the column starts NULL and
    // is filled in by the set-username endpoint. Uniqueness for non-null values
    // is enforced by the partial unique index below.
    username: text("username"),
    // False until the user confirms a username on the onboarding screen. New
    // users (social AND dev-login) start with a NULL `username`, so this flag —
    // not the username value — is the source of truth for "still needs
    // onboarding". Defaulted to false so new rows always start un-chosen.
    usernameChosen: boolean("username_chosen").default(false).notNull(),
    // GitHub login captured at OAuth signup via `mapProfileToUser`. Only used
    // to suggest a username during onboarding; never sent to analytics.
    githubLogin: text("github_login"),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("identity_user_email_unique").on(table.email),
    // Partial unique index: uniqueness only applies to non-null usernames, so
    // multiple un-onboarded users can coexist with NULL usernames.
    uniqueIndex("identity_user_username_unique")
      .on(table.username)
      .where(sql`username IS NOT NULL`),
  ],
);

export const authSessions = identitySchema.table(
  "session",
  {
    id: authIdColumn("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    // Added by the better-auth `organization` plugin: the session's currently
    // selected organization. Plugin-managed; never set directly by us.
    activeOrganizationId: uuid("active_organization_id"),
  },
  (table) => [
    uniqueIndex("identity_session_token_unique").on(table.token),
    index("identity_session_user_id_idx").on(table.userId),
  ],
);

export const authAccounts = identitySchema.table(
  "account",
  {
    id: authIdColumn("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("identity_account_user_id_idx").on(table.userId),
    uniqueIndex("identity_account_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const authVerifications = identitySchema.table(
  "verification",
  {
    id: authIdColumn("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index("identity_verification_identifier_idx").on(table.identifier)],
);

export const authDeviceCodes = identitySchema.table(
  "device_code",
  {
    id: authIdColumn("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: uuid("user_id").references(() => authUsers.id, {
      onDelete: "cascade",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (table) => [
    uniqueIndex("identity_device_code_device_code_unique").on(table.deviceCode),
    uniqueIndex("identity_device_code_user_code_unique").on(table.userCode),
    index("identity_device_code_user_id_idx").on(table.userId),
  ],
);

// --- better-auth `organization` plugin tables ---
//
// These are managed by the better-auth `organization` plugin. We declare them
// in Drizzle so they live in the `identity` schema and so `betterAuthDrizzleSchema`
// can hand the adapter concrete tables. The adapter resolves columns by the
// plugin's field keys (e.g. `organizationId`), so the property names below must
// match those keys exactly; DB column names (snake_case) are free.
//
// IDs are uuid because `advanced.database.generateId` is set globally to
// `createAuthId()` (uuid v7), so the plugin generates uuid ids for these rows.

export const authOrganizations = identitySchema.table(
  "organization",
  {
    id: authIdColumn("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex("identity_organization_slug_unique").on(table.slug)],
);

export const authMembers = identitySchema.table(
  "member",
  {
    id: authIdColumn("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => authOrganizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("identity_member_organization_id_idx").on(table.organizationId),
    index("identity_member_user_id_idx").on(table.userId),
  ],
);

export const authInvitations = identitySchema.table(
  "invitation",
  {
    id: authIdColumn("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => authOrganizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("identity_invitation_organization_id_idx").on(table.organizationId),
    index("identity_invitation_email_idx").on(table.email),
  ],
);

export const authJwks = identitySchema.table("jwks", {
  id: authIdColumn("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: createdAtColumn(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});

export const betterAuthDrizzleSchema = {
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
  deviceCode: authDeviceCodes,
  organization: authOrganizations,
  member: authMembers,
  invitation: authInvitations,
  jwks: authJwks,
};

export type BetterAuthDrizzleSchema = typeof betterAuthDrizzleSchema;
