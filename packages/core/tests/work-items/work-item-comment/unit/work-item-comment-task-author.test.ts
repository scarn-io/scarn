import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import { listWorkItemComments } from "@/work-items/work-item-comment/application/list-work-item-comments";
import {
  aWorkItemId,
  anAgentTaskComment,
  fakeCommentRepo,
  fakeCommentTaskNameReader,
  fakeUsernameReader,
  fakeWorkItemRepo,
  grantingAuthz,
} from "./work-item-comment-test-support";

describe("listWorkItemComments agent Task authors", () => {
  concurrentTest(
    "resolves an agent Task comment's authorName from its Task at read time",
    async () => {
      const projectId = createUuidV7();
      const workItemId = aWorkItemId();
      const taskId = createUuidV7();
      const comment = anAgentTaskComment({
        projectId,
        workItemId,
        authoredByTaskId: taskId,
      });

      const [result] = await listWorkItemComments(workItemId, {
        userAuthz: grantingAuthz(),
        workItemRepo: fakeWorkItemRepo({ projectId }),
        workItemCommentRepo: fakeCommentRepo(comment).repo,
        usernameReader: fakeUsernameReader(),
        commentTaskNameReader: fakeCommentTaskNameReader(
          new Map([[taskId, "Triage agent"]]),
        ),
      });

      expect(result).toMatchObject({
        authorKind: "agent",
        authoredByTaskId: taskId,
        authorName: "Triage agent",
        authorUsername: null,
      });
    },
  );

  concurrentTest(
    "an agent comment whose Task no longer resolves has a null authorName",
    async () => {
      const projectId = createUuidV7();
      const workItemId = aWorkItemId();
      const comment = anAgentTaskComment({
        projectId,
        workItemId,
        authoredByTaskId: createUuidV7(),
      });

      const [result] = await listWorkItemComments(workItemId, {
        userAuthz: grantingAuthz(),
        workItemRepo: fakeWorkItemRepo({ projectId }),
        workItemCommentRepo: fakeCommentRepo(comment).repo,
        usernameReader: fakeUsernameReader(),
        commentTaskNameReader: fakeCommentTaskNameReader(),
      });

      expect(result?.authorName).toBeNull();
    },
  );
});
