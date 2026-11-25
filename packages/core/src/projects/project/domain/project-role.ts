import { z } from "zod";
import {
  PROJECT_PERMISSIONS,
  type ProjectPermission,
} from "./project-permission";

/**
 * Built-in project roles. A membership (and an invite) stores one of these
 * names; the permissions it grants are resolved from this map at read time.
 *
 * `admin` is granted every permission in the canonical vocabulary, so new
 * permissions reach admins automatically. `write` is an explicit allow-list on
 * top of `read`. A stored role this code doesn't know grants nothing.
 */

export const PROJECT_ROLE_NAMES = ["read", "write", "admin"] as const;

export type ProjectRole = (typeof PROJECT_ROLE_NAMES)[number];

export const projectRoleSchema = z.enum(PROJECT_ROLE_NAMES);

export const isProjectRole = (value: string): value is ProjectRole =>
  (PROJECT_ROLE_NAMES as readonly string[]).includes(value);

const ALL_PROJECT_PERMISSIONS: readonly ProjectPermission[] =
  PROJECT_PERMISSIONS;

const READ_PERMISSIONS = ALL_PROJECT_PERMISSIONS.filter((permission) =>
  permission.endsWith(":read"),
);

const WRITE_PERMISSIONS: readonly ProjectPermission[] = [
  ...READ_PERMISSIONS,
  "comments:write",
  "executions:write",
  "work-item-platform-comment:write",
  "work-items:write",
].sort();

export type ProjectRoleDefinition = {
  readonly name: ProjectRole;
  readonly label: string;
  readonly description: string;
  readonly permissions: readonly ProjectPermission[];
};

export const PROJECT_ROLES: readonly ProjectRoleDefinition[] = [
  {
    name: "read",
    label: "Read",
    description: "View work items, comments and pipeline runs.",
    permissions: READ_PERMISSIONS,
  },
  {
    name: "write",
    label: "Write",
    description:
      "Edit work items, answer agents, and start, rerun or cancel pipeline runs.",
    permissions: WRITE_PERMISSIONS,
  },
  {
    name: "admin",
    label: "Admin",
    description:
      "Everything, including pipelines, settings, integrations, project secrets and who can access the project.",
    permissions: ALL_PROJECT_PERMISSIONS,
  },
];

const ROLE_PERMISSIONS: ReadonlyMap<string, readonly ProjectPermission[]> =
  new Map(PROJECT_ROLES.map((role) => [role.name, role.permissions]));

export const permissionsForRole = (
  role: string,
): readonly ProjectPermission[] => ROLE_PERMISSIONS.get(role) ?? [];

export const rolesGrantingPermission = (
  permission: ProjectPermission,
): ProjectRole[] =>
  PROJECT_ROLES.filter((role) => role.permissions.includes(permission)).map(
    (role) => role.name,
  );
