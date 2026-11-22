import { describe, expect } from "bun:test";
import { ANONYMOUS_ACTOR_ID } from "@/access/authorization/anonymous-actor";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  assertCanManageConversation,
  conversationCapabilities,
} from "@/conversations/conversation/application/conversation-capabilities";
import { CoreError } from "@/lib/errors";
import { ProjectEntity } from "@/projects/project/domain/project-entity";
import { concurrentTest } from "tests/utils";

const reader = createUuidV7();
const creator = createUuidV7();
const manager = createUuidV7();
const outsider = createUuidV7();

const aProject = (
  visibility: "private" | "public",
  members: { userId: UuidV7; role: string }[] = [
    { userId: reader, role: "read" },
    { userId: creator, role: "write" },
    { userId: manager, role: "write" },
  ],
) => {
  const id = createUuidV7();
  return ProjectEntity.rehydrate({
    id,
    name: "Chat Project",
    slug: "chat-project",
    gitUrl: "https://github.com/example/chat.git",
    createdByUserId: manager,
    orgId: createUuidV7(),
    visibility,
    memberships: members.map((member) => ({ projectId: id, ...member })),
  });
};

const none = {
  canReply: false,
  canRetry: false,
  canEnd: false,
  canDelete: false,
};

describe("conversation capabilities", () => {
  concurrentTest.each([
    ["an anonymous public reader", "public", ANONYMOUS_ACTOR_ID, none],
    [
      "an anonymous viewer of a private project",
      "private",
      ANONYMOUS_ACTOR_ID,
      none,
    ],
    ["a signed-in outsider", "public", outsider, none],
    ["a reader", "private", reader, none],
    [
      "the creator",
      "private",
      creator,
      { canReply: true, canRetry: true, canEnd: true, canDelete: true },
    ],
    [
      "a manager",
      "private",
      manager,
      { canReply: true, canRetry: true, canEnd: true, canDelete: true },
    ],
  ] as const)("%s", (_label, visibility, viewer, expected) => {
    expect(
      conversationCapabilities(aProject(visibility), creator, viewer),
    ).toEqual(expected);
  });

  concurrentTest(
    "a creator removed from the project can no longer end or delete",
    () => {
      const project = aProject("public", [
        { userId: manager, role: "write" },
      ]);
      expect(conversationCapabilities(project, creator, creator)).toEqual(none);
      expect(() => {
        assertCanManageConversation(project, creator, creator);
      }).toThrow(CoreError);
    },
  );

  concurrentTest(
    "refusing to manage is 401 without a session and 403 otherwise",
    () => {
      const project = aProject("public");
      const statusOf = (viewer: UuidV7) => {
        try {
          assertCanManageConversation(project, creator, viewer);
        } catch (error) {
          return error instanceof CoreError ? error.status : null;
        }
        return 200;
      };
      expect(statusOf(ANONYMOUS_ACTOR_ID)).toBe(401);
      expect(statusOf(reader)).toBe(403);
      expect(statusOf(creator)).toBe(200);
      expect(statusOf(manager)).toBe(200);
    },
  );
});
