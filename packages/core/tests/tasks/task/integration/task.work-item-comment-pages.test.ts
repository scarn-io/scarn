import { describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createCommentReadFixture } from "tests/tasks/task/work-item-comments-test-support";

describe("claim-authorized comment pages", () => {
  concurrentTest(
    "empty thread and live posted, replied, edited, deleted and repinned content",
    async () => {
      const h = await createCommentReadFixture();
      const claim = await h.claim();
      expect((await unwrapAsync(claim.read())).comments).toEqual({
        items: [],
        totalCount: 0,
        nextCursor: null,
      });
      const parent = await h.post(
        "Human finding\n" + "complete body ".repeat(1000),
      );
      h.advance(1000);
      const reply = await h.post("Reply finding", h.item, parent.id);
      let page = (await unwrapAsync(claim.read())).comments;
      expect(page.totalCount).toBe(2);
      expect(page.items.map((c) => c.id)).toEqual([reply.id, parent.id]);
      expect(page.items[1]).toMatchObject({
        body: parent.body,
        authorKind: "user",
        parentCommentId: null,
      });
      expect(page.items[0]).toMatchObject({
        body: reply.body,
        parentCommentId: parent.id,
      });
      expect(page.items.every((c) => c.authorName.trim().length > 0)).toBe(
        true,
      );
      await unwrapAsync(
        h.api.api["work-item-comments"]({ commentId: parent.id }).patch(
          { body: "Edited finding" },
          { headers: h.headers },
        ),
      );
      await unwrapAsync(
        h.api.api["work-item-comments"]({ commentId: parent.id }).pin.post(
          { isPinned: true },
          { headers: h.headers },
        ),
      );
      page = (await unwrapAsync(claim.read())).comments;
      expect(page.items[0]).toMatchObject({
        id: parent.id,
        body: "Edited finding",
        isPinned: true,
      });
      await unwrapAsync(
        h.api.api["work-item-comments"]({ commentId: parent.id }).pin.post(
          { isPinned: false },
          { headers: h.headers },
        ),
      );
      expect((await unwrapAsync(claim.read())).comments.items[0]?.id).toBe(
        reply.id,
      );
      await unwrapAsync(
        h.api.api["work-item-comments"]({ commentId: parent.id }).pin.post(
          { isPinned: true },
          { headers: h.headers },
        ),
      );
      expect((await unwrapAsync(claim.read())).comments.items[0]?.id).toBe(
        parent.id,
      );
      await unwrapAsync(
        h.api.api["work-item-comments"]({ commentId: reply.id }).delete(
          undefined,
          { headers: h.headers },
        ),
      );
      page = (await unwrapAsync(claim.read())).comments;
      expect(page.items.map((c) => c.id)).toEqual([parent.id]);
      expect(page.totalCount).toBe(1);
    },
    30_000,
  );

  concurrentTest(
    "pinned overflow and timestamp ties paginate without missing or duplicate IDs; deleted anchors remain usable",
    async () => {
      const h = await createCommentReadFixture();
      const posted = [];
      const unpinned = await h.post("Unpinned parent outside the first page");
      for (let i = 0; i < 55; i++) {
        const comment = await h.post(
          `Pinned finding ${String(i)}`,
          h.item,
          i === 54 ? unpinned.id : undefined,
        );
        await unwrapAsync(
          h.api.api["work-item-comments"]({ commentId: comment.id }).pin.post(
            { isPinned: true },
            { headers: h.headers },
          ),
        );
        posted.push(comment);
      }
      const claim = await h.claim();
      const first = (await unwrapAsync(claim.read())).comments;
      expect(first.items).toHaveLength(50);
      expect(first.totalCount).toBe(56);
      expect(first.items.every((c) => c.isPinned)).toBe(true);
      expect(
        first.items.find((c) => c.parentCommentId === unpinned.id),
      ).toBeDefined();
      expect(first.items.some((c) => c.id === unpinned.id)).toBe(false);
      expect(new Set(first.items.map((c) => c.createdAt)).size).toBe(1);
      if (!first.nextCursor) throw new Error("Expected next page");
      const second = (await unwrapAsync(claim.read(h.item, first.nextCursor)))
        .comments;
      expect(second.items).toHaveLength(6);
      expect(second.totalCount).toBe(56);
      expect(second.nextCursor).toBeNull();
      const expected = [
        ...posted
          .map((c) => c.id)
          .sort()
          .reverse(),
        unpinned.id,
      ];
      const ids = [...first.items, ...second.items].map((c) => c.id);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(56);
      const anchor = first.items.at(-1);
      if (!anchor) throw new Error("Expected cursor anchor");
      await unwrapAsync(
        h.api.api["work-item-comments"]({ commentId: anchor.id }).delete(
          undefined,
          { headers: h.headers },
        ),
      );
      const afterDelete = (
        await unwrapAsync(claim.read(h.item, first.nextCursor))
      ).comments;
      expect(afterDelete.items.map((c) => c.id)).toEqual(
        second.items.map((c) => c.id),
      );
      expect(afterDelete.totalCount).toBe(55);
      const malformed = await claim.read(h.item, "not-a-cursor");
      expect(malformed.data).toBeNull();
      expect(malformed.error?.status).toBe(422);
    },
    60_000,
  );
});
