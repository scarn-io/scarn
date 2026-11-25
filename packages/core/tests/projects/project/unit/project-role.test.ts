import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { PROJECT_PERMISSIONS } from "@/projects/project/domain/project-permission";
import {
  PROJECT_ROLES,
  isProjectRole,
  permissionsForRole,
  projectRoleSchema,
  rolesGrantingPermission,
} from "@/projects/project/domain/project-role";

const READ_ROLE_PERMISSIONS = [
  "comments:read",
  "executions:read",
  "integrations:read",
  "members:read",
  "pipelines:read",
  "secrets:read",
  "settings:read",
  "work-item-platform-comment:read",
  "work-items:read",
];

const WRITE_ROLE_PERMISSIONS = [
  "comments:read",
  "comments:write",
  "executions:read",
  "executions:write",
  "integrations:read",
  "members:read",
  "pipelines:read",
  "secrets:read",
  "settings:read",
  "work-item-platform-comment:read",
  "work-item-platform-comment:write",
  "work-items:read",
  "work-items:write",
];

const ADMIN_ROLE_PERMISSIONS = [
  "comments:read",
  "comments:write",
  "executions:read",
  "executions:write",
  "integrations:read",
  "integrations:write",
  "members:read",
  "members:write",
  "pipelines:read",
  "pipelines:write",
  "secrets:read",
  "secrets:write",
  "settings:read",
  "settings:write",
  "work-item-platform-comment:read",
  "work-item-platform-comment:write",
  "work-items:read",
  "work-items:write",
];

describe("project roles", () => {
  concurrentTest("are read, write and admin, in that order", () => {
    expect(PROJECT_ROLES.map((role) => role.name)).toEqual([
      "read",
      "write",
      "admin",
    ]);
  });

  concurrentTest("read grants every :read permission and nothing else", () => {
    expect(permissionsForRole("read")).toEqual(READ_ROLE_PERMISSIONS);
  });

  concurrentTest(
    "write adds work items, comments, running pipelines and tracker comments",
    () => {
      expect(permissionsForRole("write")).toEqual(WRITE_ROLE_PERMISSIONS);
    },
  );

  concurrentTest("admin has every permission", () => {
    expect(permissionsForRole("admin")).toEqual(ADMIN_ROLE_PERMISSIONS);
    expect(permissionsForRole("admin")).toEqual([...PROJECT_PERMISSIONS]);
  });

  concurrentTest("a role the code doesn't know grants nothing", () => {
    expect(permissionsForRole("contributor")).toEqual([]);
    expect(permissionsForRole("")).toEqual([]);
  });

  concurrentTest("only the three role names are accepted at the edges", () => {
    expect(isProjectRole("write")).toBe(true);
    expect(isProjectRole("reviewer")).toBe(false);
    expect(projectRoleSchema.safeParse("admin").success).toBe(true);
    expect(projectRoleSchema.safeParse("owner").success).toBe(false);
  });

  concurrentTest("lists the roles that grant a permission", () => {
    expect(rolesGrantingPermission("executions:read")).toEqual([
      "read",
      "write",
      "admin",
    ]);
    expect(rolesGrantingPermission("executions:write")).toEqual([
      "write",
      "admin",
    ]);
    expect(rolesGrantingPermission("secrets:write")).toEqual(["admin"]);
    expect(rolesGrantingPermission("pipelines:write")).toEqual(["admin"]);
    expect(rolesGrantingPermission("unknown:read")).toEqual([]);
  });
});
