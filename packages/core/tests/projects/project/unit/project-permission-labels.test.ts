import { describe, expect } from "bun:test";
import {
  ACTION_LABELS,
  formatProjectPermission,
  RESOURCE_LABELS,
} from "@/projects/project/domain/project-permission-labels";
import {
  PROJECT_ACTIONS,
  PROJECT_RESOURCES,
} from "@/projects/project/domain/project-permission";
import { concurrentTest } from "tests/utils";

describe("formatProjectPermission", () => {
  concurrentTest("labels every canonical resource and action", () => {
    expect(Object.keys(RESOURCE_LABELS).sort()).toEqual(
      [...PROJECT_RESOURCES].sort(),
    );
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(
      [...PROJECT_ACTIONS].sort(),
    );
  });

  concurrentTest("reads as an action on a resource", () => {
    expect(formatProjectPermission("work-items:read")).toBe("View work items");
    expect(formatProjectPermission("executions:delete")).toBe(
      "Delete pipeline runs",
    );
    expect(formatProjectPermission("work-item-platform-comment:create")).toBe(
      "Create tracker comments",
    );
    expect(formatProjectPermission("secrets:write")).toBe(
      "Edit project secrets",
    );
    expect(formatProjectPermission("pipelines:write")).toBe("Edit pipelines");
    expect(formatProjectPermission("members:write")).toBe(
      "Edit members and invites",
    );
  });

  concurrentTest("falls back to the raw string outside the vocabulary", () => {
    expect(formatProjectPermission("future-thing:read")).toBe(
      "future-thing:read",
    );
    expect(formatProjectPermission("work-items:launch")).toBe(
      "work-items:launch",
    );
    expect(formatProjectPermission("malformed")).toBe("malformed");
    expect(formatProjectPermission("a:b:c")).toBe("a:b:c");
  });
});
