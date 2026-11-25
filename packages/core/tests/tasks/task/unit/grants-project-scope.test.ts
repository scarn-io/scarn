import { describe, expect, test } from "bun:test";
import {
  createGrantFor,
  grantKindRefusals,
  updateGrantFor,
  type Grant,
} from "@/tasks/task/domain/grants";

const READ_SELF: Grant = {
  resource: "workItem",
  action: "read",
  scope: "self",
};

describe("grantKindRefusals", () => {
  const readProject: Grant = {
    resource: "workItem",
    action: "read",
    scope: "project",
  };
  const createProject: Grant = {
    resource: "workItem",
    action: "create",
    scope: "project",
    labels: ["acme"],
  };
  const updateProject: Grant = {
    resource: "workItem",
    action: "update",
    scope: "project",
    keyPrefix: "ACME-",
  };

  test("a code step may hold read, create and update on project", () => {
    expect(
      grantKindRefusals("code", [readProject, createProject, updateProject]),
    ).toEqual([]);
  });

  test("a code step may not hold other actions or scopes", () => {
    expect(
      grantKindRefusals("code", [
        READ_SELF,
        { resource: "workItem", action: "update", scope: "self" },
        {
          resource: "workItem",
          action: "create",
          scope: "children",
          labels: ["a"],
        },
      ]),
    ).toHaveLength(3);
  });

  test("only a code step may hold update on project", () => {
    for (const kind of ["user_defined", "built_in", "mcp_tool"]) {
      expect(grantKindRefusals(kind, [updateProject])).toHaveLength(1);
      expect(grantKindRefusals(kind, [readProject, createProject])).toEqual([]);
    }
  });
});

describe("createGrantFor and updateGrantFor", () => {
  const grants: Grant[] = [
    {
      resource: "workItem",
      action: "create",
      scope: "project",
      labels: ["jira"],
      keyPrefix: "ACME-",
    },
    {
      resource: "workItem",
      action: "update",
      scope: "project",
      keyPrefix: "ACME-",
    },
    {
      resource: "workItem",
      action: "update",
      scope: "project",
      keyPrefix: "ACME-OPS-",
      labels: ["ops"],
    },
  ];

  test("find the grant whose keyPrefix the key starts with", () => {
    expect(createGrantFor(grants, "ACME-1")?.labels).toEqual(["jira"]);
    expect(createGrantFor(grants, "OTHER-1")).toBeUndefined();
    expect(updateGrantFor(grants, "ACME-1")?.keyPrefix).toBe("ACME-");
    expect(updateGrantFor(grants, "acme-1")).toBeUndefined();
  });

  test("prefer the longest matching keyPrefix", () => {
    expect(updateGrantFor(grants, "ACME-OPS-7")?.keyPrefix).toBe("ACME-OPS-");
  });

  test("a grant with no keyPrefix covers every key", () => {
    const update: Grant = {
      resource: "workItem",
      action: "update",
      scope: "project",
    };
    const open = [update];
    expect(updateGrantFor(open, "anything")).toBe(update);
    expect(createGrantFor(open, "anything")).toBeUndefined();
  });

  test("ignore grants on other scopes", () => {
    expect(
      updateGrantFor(
        [{ resource: "workItem", action: "update", scope: "self" }],
        "ACME-1",
      ),
    ).toBeUndefined();
  });
});
