import { describe, expect, test } from "bun:test";
import { formatActivity } from "../src/format-activity";
import { formatCommentDrafts, formatComments } from "../src/format-comments";
import {
  makeActivityEntry,
  makeComment,
  makeCommentDraft,
  WORK_ITEM_ID,
} from "./work-item-fixtures";

describe("formatComments", () => {
  test("renders each comment with its author, flags and body", () => {
    expect(
      formatComments({
        workItemId: WORK_ITEM_ID,
        total: 3,
        comments: [
          makeComment({ isPinned: true }),
          makeComment({
            id: "0196a000-0000-7000-8000-0000000000f2",
            authorKind: "agent",
            authorName: "scarn",
            authorUsername: null,
            authoredByTaskId: "0196a000-0000-7000-8000-0000000000ee",
            parentCommentId: "0196a000-0000-7000-8000-0000000000f1",
            externalCommentUrl:
              "https://github.com/acme/app/issues/7#issuecomment-1",
            body: "Found it.\nThe fixture leaks a session.",
            createdAt: "2026-01-02T02:10:00.000Z",
          }),
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Comments on work item 0196a000-0000-7000-8000-0000000000aa (2 of 3)
        … 1 earlier not shown; raise --limit

        2026-01-02T02:00:00.000Z  @ada  0196a000-0000-7000-8000-0000000000f1  (pinned)
          Seen again on main.

        2026-01-02T02:10:00.000Z  scarn (agent)  0196a000-0000-7000-8000-0000000000f2  (reply to 0196a000-0000-7000-8000-0000000000f1, task 0196a000-0000-7000-8000-0000000000ee)
          https://github.com/acme/app/issues/7#issuecomment-1
          Found it.
          The fixture leaks a session.

      → scarn work-items activity 0196a000-0000-7000-8000-0000000000aa"
    `);
  });

  test("points at drafts when there are no comments", () => {
    expect(formatComments({ workItemId: WORK_ITEM_ID, comments: [], total: 0 }))
      .toMatchInlineSnapshot(`
      "No comments on work item 0196a000-0000-7000-8000-0000000000aa.

      → scarn work-items comments 0196a000-0000-7000-8000-0000000000aa --drafts"
    `);
  });
});

describe("formatCommentDrafts", () => {
  test("renders each pending draft and points at the work item's runs", () => {
    expect(
      formatCommentDrafts({
        workItemId: WORK_ITEM_ID,
        total: 1,
        drafts: [makeCommentDraft()],
      }),
    ).toMatchInlineSnapshot(`
      "Pending comment drafts on work item 0196a000-0000-7000-8000-0000000000aa (1 of 1)

        2026-01-02T03:00:00.000Z  0196a000-0000-7000-8000-0000000000f9  pending  Investigation summary
          run 0196a000-0000-7000-8000-0000000000bb
          task 0196a000-0000-7000-8000-0000000000ee
          The fixture leaks a session between tests.

      → scarn runs list --work-item 0196a000-0000-7000-8000-0000000000aa"
    `);
  });
});

describe("formatActivity", () => {
  test("renders one line per entry, continuing multi-line messages", () => {
    expect(
      formatActivity({
        workItemId: WORK_ITEM_ID,
        total: 4,
        entries: [
          makeActivityEntry(),
          makeActivityEntry({
            id: "0196a000-0000-7000-8000-0000000000a2",
            message: "Attached wayfinder.\nIt will run on the next update.",
            createdAt: "2026-01-02T00:40:00.000Z",
          }),
        ],
      }),
    ).toMatchInlineSnapshot(`
      "Activity on work item 0196a000-0000-7000-8000-0000000000aa (2 of 4)
        … 2 earlier not shown; raise --limit
        2026-01-02T00:29:00.000Z  automation  Started triage on this work item.
        2026-01-02T00:40:00.000Z  automation  Attached wayfinder.
            It will run on the next update.

      → scarn work-items comments 0196a000-0000-7000-8000-0000000000aa"
    `);
  });

  test("says so when there is no activity", () => {
    expect(formatActivity({ workItemId: WORK_ITEM_ID, entries: [], total: 0 }))
      .toMatchInlineSnapshot(`
      "No activity on work item 0196a000-0000-7000-8000-0000000000aa.

      → scarn work-items view 0196a000-0000-7000-8000-0000000000aa"
    `);
  });
});
