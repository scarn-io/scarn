import { describe, expect } from "bun:test";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createCommentReadFixture } from "tests/tasks/task/work-item-comments-test-support";
import { grant } from "tests/tasks/task/grants-test-support";

describe("comment read authorization", () => {
  concurrentTest(
    "read grants expose own and permitted child comments, not sibling threads or relation summaries",
    async () => {
      const h = await createCommentReadFixture();
      const claim = await h.claim(h.item, [
        grant("read", "self"),
        grant("read", "children"),
        grant("create", "children", ["coverage"]),
      ]);
      const child = createWorkItemId();
      const sibling = createWorkItemId();
      for (const workItemId of [child, sibling]) {
        await unwrapAsync(
          claim.run["work-item-creates"].post({
            claimToken: claim.claimToken,
            workItemId,
            title: "Child",
            description: "Child subject",
            labels: ["coverage"],
          }),
        );
      }
      const ownComment = await h.post("Own thread");
      const childComment = await h.post("Child thread", child);
      await h.post("Sibling private thread", sibling);
      const blocker = await h.createItem();
      await h.post("Blocker private thread", blocker);
      await unwrapAsync(
        h.api.api["work-item-blocks"].post(
          {
            blockedWorkItemId: h.item,
            blockingWorkItemId: blocker,
          },
          { headers: h.headers },
        ),
      );
      const own = await unwrapAsync(claim.read());
      expect(own.comments.items.map((c) => c.id)).toEqual([ownComment.id]);
      expect(own.children.map((c) => c.id).sort()).toEqual(
        [child, sibling].sort(),
      );
      expect(own.children.every((c) => !("comments" in c))).toBe(true);
      expect(own.blockers.map((c) => c.id)).toEqual([blocker]);
      expect(own.blockers.every((c) => !("comments" in c))).toBe(true);
      const childRead = await unwrapAsync(claim.read(child));
      expect(childRead.comments.items.map((c) => c.id)).toEqual([
        childComment.id,
      ]);
      const childClaim = await h.claim(child);
      const denied = await childClaim.read(sibling);
      expect(denied.data).toBeNull();
      expect(denied.error?.status).toBe(422);
    },
    30_000,
  );

  concurrentTest(
    "project read exposes permitted item comments but rejects cross-project items and foreign cursors",
    async () => {
      const h = await createCommentReadFixture();
      const target = await h.createItem();
      const targetComment = await h.post("Permitted project thread", target);
      const claim = await h.claim(h.item, [grant("read", "project")]);
      expect(
        (await unwrapAsync(claim.read(target))).comments.items.map((c) => c.id),
      ).toEqual([targetComment.id]);
      const foreignProject = await h.createProject();
      const foreignItem = await h.createItem(foreignProject.id);
      await h.post("Cross-project secret", foreignItem);
      const denied = await claim.read(foreignItem);
      expect(denied.data).toBeNull();
      expect(denied.error?.status).toBe(404);
      for (let i = 0; i < 51; i++)
        await h.post(`Source cursor comment ${String(i)}`);
      const cursor = (await unwrapAsync(claim.read())).comments.nextCursor;
      if (!cursor) throw new Error("Expected cursor");
      const foreignCursor = await claim.read(target, cursor);
      expect(foreignCursor.data).toBeNull();
      expect(foreignCursor.error?.status).toBe(422);
    },
    30_000,
  );

  concurrentTest(
    "missing or invalid claim tokens and expired leases never expose comments",
    async () => {
      const h = await createCommentReadFixture();
      await h.post("Claim protected");
      const claim = await h.claim();
      const missing = await claim.run["work-item-reads"].post(
        // @ts-expect-error Deliberately exercise HTTP validation without a required token.
        { workItemId: h.item },
      );
      expect(missing.data).toBeNull();
      expect(missing.error?.status).toBe(422);
      const invalid = await claim.read(
        h.item,
        undefined,
        "invalid-claim-token",
      );
      expect(invalid.data).toBeNull();
      expect(invalid.error?.status).toBe(409);
      h.advance(31_000);
      const expired = await claim.read();
      expect(expired.data).toBeNull();
      expect(expired.error?.status).toBe(409);
    },
    30_000,
  );

  concurrentTest(
    "a read grant and claim do not authorize posting comments",
    async () => {
      const h = await createCommentReadFixture();
      const claim = await h.claim();
      expect((await unwrapAsync(claim.read())).comments.totalCount).toBe(0);
      const direct = await h.api.api["work-item-comments"].post(
        { workItemId: h.item, body: "Unauthorized direct post" },
        {
          headers: { authorization: `Bearer ${claim.claimToken}` },
        },
      );
      expect(direct.data).toBeNull();
      expect(direct.error?.status).toBe(401);
      const completion = await unwrapAsync(
        claim.run.completions.post(
          {
            claimToken: claim.claimToken,
            status: "succeeded",
            resultJson: {},
            errorJson: null,
            workItemChanges: [
              {
                kind: "comment",
                workItemId: parseUuidV7(h.item),
                body: "Unauthorized completion post",
              },
            ],
          },
          { headers: h.headers },
        ),
      );
      expect(completion.status).toBe("failed");
      expect(completion.errorJson).toMatchObject({
        name: "Scarn.WorkItemChangesInvalid",
      });
      const reader = await h.claim();
      expect((await unwrapAsync(reader.read())).comments.totalCount).toBe(0);
    },
    30_000,
  );
});
