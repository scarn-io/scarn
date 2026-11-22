import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  PROJECT_ACTIONS,
  PROJECT_PERMISSIONS,
} from "@/projects/project/domain/project-permission";
import {
  PROJECT_ROLES,
  isProjectRole,
  permissionsForRole,
  projectRoleSchema,
  rolesGrantingPermission,
} from "@/projects/project/domain/project-role";

const everyPermission = [...PROJECT_PERMISSIONS];

const CONFIG_PERMISSIONS = [
  "pipelines:write",
  "settings:write",
  "integrations:write",
  "members:write",
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
    expect(permissionsForRole("read")).toEqual(
      everyPermission.filter((permission) => permission.endsWith(":read")).sort(),
    );
  });

  concurrentTest(
    "write adds work items, comments, running pipelines and tracker comments",
    () => {
      const write = permissionsForRole("write");

      for (const permission of permissionsForRole("read")) {
        expect(write).toContain(permission);
      }
      for (const action of PROJECT_ACTIONS) {
        expect(write).toContain(`work-items:${action}`);
        expect(write).toContain(`comments:${action}`);
      }
      expect(write).toContain("executions:write");
      expect(write).toContain("executions:delete");
      expect(write).toContain("work-item-platform-comment:create");
      expect(write).not.toContain("secrets:write");
      expect(write).not.toContain("secrets:delete");
      expect(write).not.toContain("executions:create");
      for (const permission of CONFIG_PERMISSIONS) {
        expect(write).not.toContain(permission);
      }
    },
  );

  concurrentTest("admin has every permission", () => {
    expect(permissionsForRole("admin")).toEqual([...everyPermission].sort());
    for (const permission of CONFIG_PERMISSIONS) {
      expect(permissionsForRole("admin")).toContain(permission);
    }
  });

  concurrentTest(
    "config resources only exist as :write, so read gains nothing",
    () => {
      for (const resource of ["pipelines", "settings", "integrations", "members"]) {
        expect(everyPermission).not.toContain(`${resource}:read`);
        expect(everyPermission).not.toContain(`${resource}:delete`);
      }
      expect(permissionsForRole("read")).not.toContain("pipelines:write");
    },
  );

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
