import { describe, expect, test } from "bun:test";
import {
  findGrant,
  grantSchema,
  grantsSchema,
  scopesFor,
  taskGrants,
  type Grant,
} from "@/tasks/task/domain/grants";

const READ_SELF: Grant = {
  resource: "workItem",
  action: "read",
  scope: "self",
};

describe("grantSchema", () => {
  test("accepts a grant for every action", () => {
    const grants = [
      { resource: "workItem", action: "read", scope: "children" },
      { resource: "workItem", action: "update", scope: "self" },
      { resource: "workItem", action: "comment", scope: "children" },
      {
        resource: "workItem",
        action: "label",
        scope: "self",
        labels: ["bug"],
      },
      { resource: "workItem", action: "block", scope: "self" },
      { resource: "workItem", action: "close", scope: "children" },
      {
        resource: "workItem",
        action: "create",
        scope: "children",
        labels: ["wayfinder:research", "wayfinder:prototype"],
      },
    ];
    for (const grant of grants) {
      expect(grantSchema.safeParse(grant).success).toBe(true);
    }
  });

  test("rejects an unknown resource, action or scope", () => {
    expect(
      grantSchema.safeParse({ resource: "repo", action: "read", scope: "self" })
        .success,
    ).toBe(false);
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "delete",
        scope: "self",
      }).success,
    ).toBe(false);
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "read",
        scope: "siblings",
      }).success,
    ).toBe(false);
  });

  test("accepts project only on read and create", () => {
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "read",
        scope: "project",
      }).success,
    ).toBe(true);
    for (const action of ["update", "comment", "block", "close"]) {
      expect(
        grantSchema.safeParse({
          resource: "workItem",
          action,
          scope: "project",
        }).success,
      ).toBe(false);
    }
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "label",
        scope: "project",
        labels: ["a"],
      }).success,
    ).toBe(false);
  });

  test("accepts create on project with labels", () => {
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "create",
        scope: "project",
        labels: ["intake"],
      }).success,
    ).toBe(true);
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "create",
        scope: "project",
      }).success,
    ).toBe(false);
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "create",
        scope: "project",
        labels: [],
      }).success,
    ).toBe(false);
  });

  test("rejects create on self", () => {
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "create",
        scope: "self",
        labels: ["a"],
      }).success,
    ).toBe(false);
  });

  test("requires labels on create and label", () => {
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "create",
        scope: "children",
      }).success,
    ).toBe(false);
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "label",
        scope: "self",
      }).success,
    ).toBe(false);
  });

  test("labels must be non-empty, unique, non-blank and within labelsSchema limits", () => {
    const label = (labels: string[]) =>
      grantSchema.safeParse({
        resource: "workItem",
        action: "label",
        scope: "self",
        labels,
      });
    expect(label([]).success).toBe(false);
    expect(label(["a", "a"]).success).toBe(false);
    expect(label(["  "]).success).toBe(false);
    expect(label(["x".repeat(201)]).success).toBe(false);
    expect(
      label(Array.from({ length: 51 }, (_, i) => `l${String(i)}`)).success,
    ).toBe(false);
    expect(
      label(Array.from({ length: 50 }, (_, i) => `l${String(i)}`)).success,
    ).toBe(true);
  });

  test("trims labels", () => {
    const parsed = grantSchema.parse({
      resource: "workItem",
      action: "label",
      scope: "self",
      labels: ["  bug  "],
    });
    expect(parsed).toEqual({
      resource: "workItem",
      action: "label",
      scope: "self",
      labels: ["bug"],
    });
  });

  test("rejects labels that are only unique before trimming", () => {
    expect(
      grantSchema.safeParse({
        resource: "workItem",
        action: "label",
        scope: "self",
        labels: ["bug", " bug "],
      }).success,
    ).toBe(false);
  });
});

describe("grantsSchema", () => {
  test("accepts one grant per action and scope", () => {
    expect(
      grantsSchema.safeParse([
        READ_SELF,
        { resource: "workItem", action: "read", scope: "children" },
        { resource: "workItem", action: "close", scope: "self" },
      ]).success,
    ).toBe(true);
  });

  test("rejects two grants for the same resource, action and scope", () => {
    expect(
      grantsSchema.safeParse([
        { resource: "workItem", action: "label", scope: "self", labels: ["a"] },
        { resource: "workItem", action: "label", scope: "self", labels: ["b"] },
      ]).success,
    ).toBe(false);
  });
});

describe("taskGrants", () => {
  const ON_WORK_ITEM = {
    workItemId: "01900000-0000-7000-8000-000000000001",
    startedByScheduleId: null,
  };
  const CHAT = { workItemId: null, startedByScheduleId: null };
  const SCHEDULED = {
    workItemId: null,
    startedByScheduleId: "01900000-0000-7000-8000-000000000002",
  };
  const CREATE_PROJECT: Grant = {
    resource: "workItem",
    action: "create",
    scope: "project",
    labels: ["intake"],
  };
  const READ_PROJECT: Grant = {
    resource: "workItem",
    action: "read",
    scope: "project",
  };
  const CREATE_CHILDREN: Grant = {
    resource: "workItem",
    action: "create",
    scope: "children",
    labels: ["a"],
  };

  test("adds read on self", () => {
    const close: Grant = {
      resource: "workItem",
      action: "close",
      scope: "self",
    };
    expect(taskGrants([], ON_WORK_ITEM)).toEqual([READ_SELF]);
    expect(taskGrants([close], ON_WORK_ITEM)).toEqual([READ_SELF, close]);
  });

  test("is idempotent", () => {
    const once = taskGrants(
      [{ resource: "workItem", action: "update", scope: "self" }],
      ON_WORK_ITEM,
    );
    expect(taskGrants(once, ON_WORK_ITEM)).toEqual(once);
    expect(taskGrants([READ_SELF], ON_WORK_ITEM)).toEqual([READ_SELF]);
  });

  test("is empty for a chat", () => {
    expect(taskGrants([], CHAT)).toEqual([]);
    expect(taskGrants([READ_SELF, CREATE_PROJECT], CHAT)).toEqual([]);
  });

  test("keeps only project grants for a scheduled Task, with no read on self", () => {
    expect(
      taskGrants(
        [READ_SELF, CREATE_CHILDREN, READ_PROJECT, CREATE_PROJECT],
        SCHEDULED,
      ),
    ).toEqual([READ_PROJECT, CREATE_PROJECT]);
    expect(taskGrants([], SCHEDULED)).toEqual([]);
  });
});

describe("lookups", () => {
  const grants: Grant[] = [
    READ_SELF,
    { resource: "workItem", action: "read", scope: "children" },
    {
      resource: "workItem",
      action: "create",
      scope: "children",
      labels: ["a"],
    },
  ];

  test("findGrant finds the grant for an action and scope", () => {
    expect(findGrant(grants, "create", "children")?.labels).toEqual(["a"]);
    expect(findGrant(grants, "close", "self")).toBeUndefined();
  });

  test("scopesFor lists the scopes an action covers", () => {
    expect(scopesFor(grants, "read")).toEqual(["self", "children"]);
    expect(scopesFor(grants, "create")).toEqual(["children"]);
    expect(scopesFor(grants, "update")).toEqual([]);
  });
});
