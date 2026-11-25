import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import { ANONYMOUS_ACTOR_ID } from "@/access/authorization/anonymous-actor";
import { ProjectEntity } from "@/projects/project/domain/project-entity";
import { assertProjectPermission } from "@/projects/project/application/project-authorization";

const aProject = (
  overrides: {
    visibility?: "private" | "public";
    memberUserId?: UuidV7;
    memberRole?: string;
  } = {},
) => {
  const projectId = createUuidV7();
  const orgId = createUuidV7();
  const creatorId = createUuidV7();
  const memberUserId = overrides.memberUserId ?? createUuidV7();

  return ProjectEntity.rehydrate({
    id: projectId,
    name: "Visibility Test Project",
    slug: "visibility-test-project",
    gitUrl: "https://github.com/example/visibility-test.git",
    createdByUserId: creatorId,
    orgId,
    visibility: overrides.visibility ?? "private",
    memberships: [
      {
        projectId,
        userId: memberUserId,
        role: overrides.memberRole ?? "read",
      },
    ],
  });
};

describe("assertProjectPermission", () => {
  concurrentTest(
    "grants a member with the permission, and it is never a public-fallback grant",
    () => {
      const memberUserId = createUuidV7();
      const project = aProject({ memberUserId });

      const grant = assertProjectPermission(
        project,
        memberUserId,
        "work-items:read",
      );

      expect(grant.membership?.userId).toBe(memberUserId);
      expect(grant.isPublicNonMemberGrant).toBe(false);
    },
  );

  concurrentTest(
    "denies a non-member with 403 on a private project (read)",
    () => {
      const project = aProject({ visibility: "private" });
      const outsider = createUuidV7();

      let error: unknown = null;
      try {
        assertProjectPermission(project, outsider, "work-items:read");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).status).toBe(403);
      expect((error as CoreError).code).toBe("PROJECT_FORBIDDEN");
      expect((error as CoreError).meta).toEqual({
        permission: "work-items:read",
      });
      expect((error as CoreError).message).not.toContain(project.id);
      expect((error as CoreError).message).not.toContain(outsider);
    },
  );

  concurrentTest(
    "denies a member lacking the permission with 403, naming the permission structurally",
    () => {
      const memberUserId = createUuidV7();
      const project = aProject({ memberUserId });

      let error: unknown = null;
      try {
        assertProjectPermission(project, memberUserId, "comments:write");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).status).toBe(403);
      expect((error as CoreError).code).toBe("PROJECT_FORBIDDEN");
      expect((error as CoreError).meta).toEqual({
        permission: "comments:write",
      });
      expect((error as CoreError).message).toContain("comments:write");
      expect((error as CoreError).message).not.toContain(project.id);
      expect((error as CoreError).message).not.toContain(memberUserId);
    },
  );

  concurrentTest(
    "denies the anonymous actor with 401 (not 403) on a private project",
    () => {
      const project = aProject({ visibility: "private" });

      let error: unknown = null;
      try {
        assertProjectPermission(project, ANONYMOUS_ACTOR_ID, "work-items:read");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).status).toBe(401);
      expect((error as CoreError).code).toBe("UNAUTHORIZED");
    },
  );

  concurrentTest(
    "denies the anonymous actor with 401 on a public project write permission",
    () => {
      const project = aProject({ visibility: "public" });

      let error: unknown = null;
      try {
        assertProjectPermission(project, ANONYMOUS_ACTOR_ID, "work-items:write");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).status).toBe(401);
    },
  );

  concurrentTest(
    "grants the anonymous actor a read permission on a public project, flagged as a public non-member grant",
    () => {
      const project = aProject({ visibility: "public" });

      const grant = assertProjectPermission(
        project,
        ANONYMOUS_ACTOR_ID,
        "work-items:read",
      );

      expect(grant.membership).toBeNull();
      expect(grant.isPublicNonMemberGrant).toBe(true);
    },
  );

  concurrentTest(
    "grants a logged-in non-member a read permission on a public project, flagged as a public non-member grant",
    () => {
      const project = aProject({ visibility: "public" });
      const outsider = createUuidV7();

      const grant = assertProjectPermission(
        project,
        outsider,
        "comments:read",
      );

      expect(grant.membership).toBeNull();
      expect(grant.isPublicNonMemberGrant).toBe(true);
    },
  );

  concurrentTest(
    "denies a logged-in non-member with 403 (not 401) writing to a public project",
    () => {
      const project = aProject({ visibility: "public" });
      const outsider = createUuidV7();

      let error: unknown = null;
      try {
        assertProjectPermission(project, outsider, "work-items:write");
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).status).toBe(403);
    },
  );

  concurrentTest(
    "a member of a public project is never flagged as a public non-member grant",
    () => {
      const memberUserId = createUuidV7();
      const project = aProject({ visibility: "public", memberUserId });

      const grant = assertProjectPermission(
        project,
        memberUserId,
        "work-items:read",
      );

      expect(grant.membership?.userId).toBe(memberUserId);
      expect(grant.isPublicNonMemberGrant).toBe(false);
    },
  );

  concurrentTest(
    "a member lacking the exercised permission still isn't flagged as a public non-member grant, even though the public fallback is what actually grants it",
    () => {
      const memberUserId = createUuidV7();
      // A role this code doesn't know grants nothing, so the member lacks
      // `executions:read` outright and the fallback (not their own
      // permissions) is what grants this specific read.
      const project = aProject({
        visibility: "public",
        memberUserId,
        memberRole: "retired-role",
      });

      const grant = assertProjectPermission(
        project,
        memberUserId,
        "executions:read",
      );

      // Granted (via the public fallback)...
      expect(grant.membership?.userId).toBe(memberUserId);
      // ...but NOT counted as a public non-member grant: this is a real
      // member's read, so it must still count toward the owning org's quota.
      expect(grant.isPublicNonMemberGrant).toBe(false);
    },
  );
});
