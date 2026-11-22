import { describe, expect } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { workItemComments } from "@/lib/db/schema";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import type { WorkItemCommentId } from "@/work-items/work-item-comment/domain/work-item-comment-id";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { createCommentReadFixture } from "tests/tasks/task/work-item-comments-test-support";
import { grant } from "tests/tasks/task/grants-test-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "tests/notifications/user-notification/integration/emit-notification-signal-support";

/**
 * Reads and assertions use HTTP. Narrow database fixture updates model orphaned
 * authors (no public detach API) and microseconds (unrepresentable by Date).
 */
describe("comment content and storage precision", () => {
  concurrentTest(
    "completed agent comments resolve their author; missing human and agent identities have safe fallbacks",
    async () => {
      const h = await createCommentReadFixture();
      const human = await h.post("Human author will be unavailable");
      const writer = await h.claim(h.item, [grant("comment", "self")]);
      const completed = await unwrapAsync(
        writer.run.completions.post(
          {
            claimToken: writer.claimToken,
            status: "succeeded",
            resultJson: {},
            errorJson: null,
            workItemChanges: [
              {
                kind: "comment",
                workItemId: parseUuidV7(h.item),
                body: "Agent posted finding",
              },
            ],
          },
          { headers: h.headers },
        ),
      );
      expect(completed.status).toBe("succeeded");
      const reader = await h.claim();
      let page = (await unwrapAsync(reader.read())).comments;
      const agent = page.items.find((c) => c.authorKind === "agent");
      expect(agent).toMatchObject({
        body: "Agent posted finding",
        authorName: "Comment reader",
      });
      if (!agent) throw new Error("Expected agent comment");

      await getDb()
        .update(workItemComments)
        .set({ authorUserId: createUuidV7() })
        .where(eq(workItemComments.id, human.id));
      await getDb()
        .update(workItemComments)
        .set({ authoredByTaskId: null })
        .where(eq(workItemComments.id, agent.id));
      page = (await unwrapAsync(reader.read())).comments;
      expect(page.items.find((c) => c.id === human.id)).toMatchObject({
        authorKind: "user",
        authorName: "User",
      });
      expect(page.items.find((c) => c.id === agent.id)).toMatchObject({
        authorKind: "agent",
        authorName: "Agent",
      });
    },
    30_000,
  );

  concurrentTest(
    "pending drafts staged by real run completion stay out of posted comment pages",
    async () => {
      const h = await createCommentReadFixture();
      const item = await h.createItem(h.project.id, "github");
      const posted = await h.post("Already posted finding", item);
      const draftBody = `Unapproved private draft ${crypto.randomUUID()}`;
      await emitNotificationSignal({
        apiClient: h.api,
        authHeaders: h.headers,
        projectId: parseUuidV7(h.project.id),
        workItemId: parseUuidV7(item),
        items: [
          {
            kind: "status_update",
            body: draftBody,
            suggestedChannels: ["work_item_platform_comment"],
          },
        ],
      });
      const draft = await findPendingDraftByBody(
        h.api,
        h.headers,
        parseUuidV7(item),
        draftBody,
      );
      expect(draft.notification.body).toBe(draftBody);
      const reader = await h.claim(item);
      const page = (await unwrapAsync(reader.read())).comments;
      expect(page.totalCount).toBe(1);
      expect(page.items.map((c) => c.id)).toEqual([posted.id]);
      expect(page.items.some((c) => c.body === draftBody)).toBe(false);
      expect(page.nextCursor).toBeNull();
    },
    30_000,
  );

  concurrentTest(
    "pagination retains PostgreSQL submillisecond ordering across the page boundary",
    async () => {
      const h = await createCommentReadFixture();
      const newer: WorkItemCommentId[] = [];
      const older: WorkItemCommentId[] = [];
      for (let i = 0; i < 52; i++) {
        const posted = await h.post(`Microsecond finding ${String(i)}`);
        const highPrecisionTime =
          i % 2 === 0
            ? "2026-05-01T12:00:00.000900Z"
            : "2026-05-01T12:00:00.000100Z";
        await getDb()
          .update(workItemComments)
          .set({ createdAt: sql`${highPrecisionTime}::timestamptz` })
          .where(eq(workItemComments.id, posted.id));
        (i % 2 === 0 ? newer : older).push(posted.id);
      }
      const claim = await h.claim();
      const first = (await unwrapAsync(claim.read())).comments;
      expect(first.items).toHaveLength(50);
      expect(first.totalCount).toBe(52);
      if (!first.nextCursor) throw new Error("Expected precision cursor");
      const second = (await unwrapAsync(claim.read(h.item, first.nextCursor)))
        .comments;
      expect(second.nextCursor).toBeNull();
      expect(second.items).toHaveLength(2);
      const ids = [...first.items, ...second.items].map((c) => c.id);
      expect(ids).toEqual([
        ...newer.sort().reverse(),
        ...older.sort().reverse(),
      ]);
      expect(new Set(ids).size).toBe(52);
    },
    30_000,
  );
});
