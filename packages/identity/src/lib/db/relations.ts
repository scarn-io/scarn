import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

/** Relational-query (RQB v2) config for the identity schema. */
export const relations = defineRelations(schema, (r) => ({
  authUsers: {
    sessions: r.many.authSessions(),
    accounts: r.many.authAccounts(),
    memberships: r.many.authMembers(),
  },
  authSessions: {
    user: r.one.authUsers({
      from: r.authSessions.userId,
      to: r.authUsers.id,
    }),
  },
  authAccounts: {
    user: r.one.authUsers({
      from: r.authAccounts.userId,
      to: r.authUsers.id,
    }),
  },
  authOrganizations: {
    members: r.many.authMembers(),
    invitations: r.many.authInvitations(),
  },
  authMembers: {
    organization: r.one.authOrganizations({
      from: r.authMembers.organizationId,
      to: r.authOrganizations.id,
    }),
    user: r.one.authUsers({
      from: r.authMembers.userId,
      to: r.authUsers.id,
    }),
  },
  authInvitations: {
    organization: r.one.authOrganizations({
      from: r.authInvitations.organizationId,
      to: r.authOrganizations.id,
    }),
    inviter: r.one.authUsers({
      from: r.authInvitations.inviterId,
      to: r.authUsers.id,
    }),
  },
}));
