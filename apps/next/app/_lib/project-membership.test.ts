import { describe, expect, test } from "bun:test";
import { isProjectMember } from "./project-membership";
import type { ProjectContract } from "@scarn/api/frontend-contracts";

const buildProject = (
  memberships: ProjectContract["memberships"],
): ProjectContract =>
  ({
    id: "01966a2c-9494-7db5-aa46-0f8f5cbbe001",
    memberships,
  }) as ProjectContract;

const membership = (userId: string): ProjectContract["memberships"][number] =>
  ({
    userId,
    permissions: ["work-items:read"],
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
  }) as ProjectContract["memberships"][number];

describe("isProjectMember", () => {
  test("is true when the userId has a membership row", () => {
    const project = buildProject([membership("user-1"), membership("user-2")]);
    expect(isProjectMember(project, "user-2")).toBe(true);
  });

  test("is false when the userId has no membership row", () => {
    const project = buildProject([membership("user-1")]);
    expect(isProjectMember(project, "user-3")).toBe(false);
  });

  test("is false for a null or undefined userId (anonymous viewer)", () => {
    const project = buildProject([membership("user-1")]);
    expect(isProjectMember(project, null)).toBe(false);
    expect(isProjectMember(project, undefined)).toBe(false);
  });

  test("is false for a project with no memberships at all", () => {
    const project = buildProject([]);
    expect(isProjectMember(project, "user-1")).toBe(false);
  });
});
