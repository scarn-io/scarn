import { describe, expect, test } from "bun:test";
import { formatWorkItem, formatWorkItemList } from "../src/format-work-item";
import type { GatheredWorkItem } from "../src/gather-work-item";
import {
  makeRunListItem,
  makeProjectTask,
  makeQuestion,
  makeWorkItemChild,
  makeWorkItemDetail,
  makeWorkItemListItem,
  WORK_ITEM_ID,
} from "./work-item-fixtures";

function gathered(overrides: Partial<GatheredWorkItem> = {}): GatheredWorkItem {
  return {
    workItem: makeWorkItemDetail(),
    blocks: {
      status: "loaded",
      data: {
        blockedBy: [
          {
            id: "block-1",
            blockedWorkItemId: WORK_ITEM_ID,
            blockingWorkItemId: "0196a000-0000-7000-8000-0000000000c1",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        blocking: [],
      },
    },
    children: { status: "loaded", data: [makeWorkItemChild()] },
    questions: { status: "loaded", data: [makeQuestion()] },
    runs: {
      status: "loaded",
      data: {
        items: [makeRunListItem()],
        pagination: { page: 1, pageSize: 5, total: 1 },
      },
    },
    tasks: {
      status: "loaded",
      data: { tasks: [makeProjectTask()], nextCursor: null },
    },
    ...overrides,
  };
}

describe("formatWorkItemList", () => {
  test("renders one entry per item and ends with the view hint", () => {
    expect(
      formatWorkItemList({
        items: [
          makeWorkItemListItem(),
          makeWorkItemListItem({
            id: "0196a000-0000-7000-8000-0000000000ab",
            platformKey: "acme/app#9",
            title: "Document the release flow",
            labels: [],
            state: "closed",
            closeReason: "completed",
            latestExecutionStatus: null,
            assignee: null,
          }),
        ],
        pagination: { page: 1, pageSize: 2, total: 5 },
      }),
    ).toMatchInlineSnapshot(`
      "Work items (2 of 5)
        ✗ 0196a000…00aa  acme/app#7  Fix the flaky login test
            0196a000-0000-7000-8000-0000000000aa  open  run: failed  @ada  updated 2026-01-02T00:00:00.000Z  [bug]
        ✓ 0196a000…00ab  acme/app#9  Document the release flow
            0196a000-0000-7000-8000-0000000000ab  closed (completed)  run: —  unassigned  updated 2026-01-02T00:00:00.000Z
        … 3 more; raise --limit or narrow the filters

      → scarn work-items view 0196a000-0000-7000-8000-0000000000aa"
    `);
  });

  test("says so when nothing matches", () => {
    expect(
      formatWorkItemList({
        items: [],
        pagination: { page: 1, pageSize: 25, total: 0 },
      }),
    ).toBe("No work items match.");
  });
});

describe("formatWorkItem", () => {
  test("renders the item, every section, and the next commands", () => {
    expect(
      formatWorkItem(
        gathered({
          workItem: makeWorkItemDetail({
            fields: { priority: "high", points: 3 },
            parentWorkItemId: "0196a000-0000-7000-8000-0000000000c0",
          }),
        }),
      ),
    ).toMatchInlineSnapshot(`
      "Work item 0196a000-0000-7000-8000-0000000000aa
      Title:      Fix the flaky login test
      Key:        github acme/app#7
      URL:        https://github.com/acme/app/issues/7
      State:      open
      Labels:     bug
      Assignee:   —
      Created by: ada
      Parent:     0196a000-0000-7000-8000-0000000000c0
      Project:    0196a000-0000-7000-8000-000000000001
      Created:    2026-01-01T00:00:00.000Z
      Updated:    2026-01-02T00:00:00.000Z

      Fields:
        priority: high
        points: 3

      Description:
        The login test fails on CI about once a day.

      Blocks:
        blocked by 0196a000-0000-7000-8000-0000000000c1

      Children:
        ● 0196a000-0000-7000-8000-0000000000cc  acme/app#8  Stabilise the session fixture  running

      Questions:
        ○ 0196a000-0000-7000-8000-0000000000dd  open  asked 2026-01-02T01:00:00.000Z  run 0196a000-0000-7000-8000-0000000000bb
          Should the retry live in the fixture or the test?

      Latest runs:
        ‼ 0196a000-0000-7000-8000-0000000000bb  waiting (waiting for reply)  started 2026-01-02T00:30:00.000Z

      Latest Tasks:
        ‼ 0196a000-0000-7000-8000-0000000000ee  Investigate  waiting_for_person  created 2026-01-02T00:31:00.000Z
            message: Asked where the retry should live.

      Next:
        → scarn runs list --work-item 0196a000-0000-7000-8000-0000000000aa
        → scarn tasks view 0196a000-0000-7000-8000-0000000000ee
        → scarn work-items comments 0196a000-0000-7000-8000-0000000000aa
        → scarn work-items activity 0196a000-0000-7000-8000-0000000000aa"
    `);
  });

  test("renders a failed sub-read as one unavailable line", () => {
    const output = formatWorkItem(
      gathered({
        children: { status: "unavailable", reason: "Forbidden" },
        runs: { status: "unavailable", reason: "fetch failed" },
        blocks: { status: "loaded", data: { blockedBy: [], blocking: [] } },
      }),
    );
    expect(output).toContain("Children: (unavailable: Forbidden)");
    expect(output).toContain("Latest runs: (unavailable: fetch failed)");
    expect(output).toContain("Blocks:\n  (none)");
    expect(output).not.toContain("scarn runs list");
  });

  test("elides a long description", () => {
    const description = Array.from(
      { length: 25 },
      (_, index) => `line ${String(index + 1)}`,
    ).join("\n");
    const output = formatWorkItem(
      gathered({ workItem: makeWorkItemDetail({ description }) }),
    );
    expect(output).toContain("  line 20\n  … 5 more lines");
    expect(output).not.toContain("line 21");
  });
});
