import { describe, expect, test } from "bun:test";
import type { ConversationEvent } from "@scarn/api/frontend-contracts";
import {
  activitySummary,
  buildThreadItems,
  foldItems,
  startPrompt,
  type ActivityEvent,
  type ThreadItem,
} from "./thread-items";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq)}`;

const message = (
  id: string,
  createdMs: number,
  role: "user" | "assistant" = "assistant",
): ConversationEvent => ({ kind: "message", id, role, createdMs });

const text = (
  messageId: string,
  body: string,
  role: "user" | "assistant" = "assistant",
): ConversationEvent => ({
  kind: "text",
  messageId,
  partId: nextId("text"),
  role,
  text: body,
});

const reasoning = (messageId: string, body: string): ConversationEvent => ({
  kind: "reasoning",
  messageId,
  partId: nextId("reasoning"),
  text: body,
});

const tool = (
  messageId: string,
  name: string,
  status: "running" | "completed" = "completed",
): Extract<ConversationEvent, { kind: "tool" }> => ({
  kind: "tool",
  messageId,
  partId: nextId("tool"),
  callId: nextId("call"),
  tool: name,
  status,
});

const types = (items: ThreadItem[]) => items.map((item) => item.type);

describe("buildThreadItems", () => {
  test("text, then tools, then text gives narration, activity, narration", () => {
    const items = buildThreadItems(
      [
        message("m1", 1_000),
        text("m1", "Reading the repo."),
        tool("m1", "read"),
        tool("m1", "bash"),
        message("m2", 39_000),
        text("m2", "Found it."),
      ],
      { running: false },
    );

    expect(types(items)).toEqual(["narration", "activity", "narration"]);
    const activity = items[1];
    expect(activity).toMatchObject({
      type: "activity",
      startMs: 1_000,
      endMs: 39_000,
      active: false,
    });
    expect(
      activity?.type === "activity" ? activity.events.map((e) => e.kind) : [],
    ).toEqual(["tool", "tool"]);
  });

  test("puts a message's text before its tools", () => {
    const items = buildThreadItems(
      [message("m1", 0), tool("m1", "read"), text("m1", "Looking around.")],
      { running: false },
    );

    expect(types(items)).toEqual(["narration", "activity"]);
  });

  test("folds reasoning into the activity row", () => {
    const items = buildThreadItems(
      [
        message("m1", 0),
        text("m1", "Starting."),
        reasoning("m1", "**Checking the logs**"),
        tool("m1", "grep"),
        message("m2", 5_000),
        reasoning("m2", "Thinking more"),
        message("m3", 9_000),
        text("m3", "Done."),
      ],
      { running: false },
    );

    expect(types(items)).toEqual(["narration", "activity", "narration"]);
    const activity = items[1];
    expect(
      activity?.type === "activity" ? activity.events.map((e) => e.kind) : [],
    ).toEqual(["reasoning", "tool", "reasoning"]);
    expect(items[2]).toMatchObject({ type: "narration", text: "Done." });
  });

  test("skips the first user prompt, which becomes the start line", () => {
    const events = [
      message("u1", 0, "user"),
      text("u1", "Investigate the regression.", "user"),
      message("m1", 100),
      text("m1", "On it."),
    ];

    const items = buildThreadItems(events, { running: false });

    expect(types(items)).toEqual(["narration"]);
    expect(items[0]).toMatchObject({ text: "On it." });
    expect(startPrompt(events)).toBe("Investigate the regression.");
  });

  test("skips empty text and empty reasoning", () => {
    const items = buildThreadItems(
      [message("m1", 0), text("m1", "  "), reasoning("m1", "")],
      { running: false },
    );

    expect(items).toEqual([]);
  });

  test("a session error becomes its own item", () => {
    const items = buildThreadItems(
      [
        message("m1", 0),
        text("m1", "Running tests."),
        tool("m1", "bash"),
        { kind: "session-error", message: "provider.internal: boom" },
      ],
      { running: false },
    );

    expect(types(items)).toEqual(["narration", "activity", "session-error"]);
    expect(items[2]).toMatchObject({
      type: "session-error",
      message: "provider.internal: boom",
    });
  });

  test("marks a running run's trailing activity active", () => {
    const events = [
      message("m1", 0),
      text("m1", "Running tests."),
      tool("m1", "bash", "running"),
    ];

    expect(buildThreadItems(events, { running: true }).at(-1)).toMatchObject({
      type: "activity",
      active: true,
      endMs: null,
    });
    expect(buildThreadItems(events, { running: false }).at(-1)).toMatchObject({
      type: "activity",
      active: false,
    });
  });

  test("does not mark activity active once narration follows it", () => {
    const items = buildThreadItems(
      [
        message("m1", 0),
        tool("m1", "bash"),
        message("m2", 1_000),
        text("m2", "Done."),
      ],
      { running: true },
    );

    expect(items[0]).toMatchObject({ type: "activity", active: false });
  });
});

describe("foldItems", () => {
  const narratedRun = (count: number) =>
    buildThreadItems(
      Array.from({ length: count }, (_, index) => {
        const id = `m${String(index)}`;
        return [
          message(id, index * 10_000),
          text(id, `Update ${String(index)}`),
          tool(id, "bash"),
        ];
      }).flat(),
      { running: false },
    );

  test("keeps the last few narrations and counts the hidden ones", () => {
    const items = narratedRun(8);

    const fold = foldItems(items);

    expect(fold).toEqual({ hidden: 5, visibleFrom: 10, durationMs: 50_000 });
    expect(items[10]).toMatchObject({ type: "narration", text: "Update 5" });
  });

  test("honours a custom number of narrations to keep", () => {
    expect(foldItems(narratedRun(8), 2)).toMatchObject({
      hidden: 6,
      visibleFrom: 12,
    });
  });

  test("does not fold a short run", () => {
    expect(foldItems(narratedRun(5))).toBeNull();
  });
});

describe("activitySummary", () => {
  test("counts tools by kind", () => {
    const events: ActivityEvent[] = [
      tool("m", "read"),
      tool("m", "read"),
      tool("m", "read"),
      tool("m", "read"),
      tool("m", "bash"),
      tool("m", "bash"),
      tool("m", "grep"),
      tool("m", "edit"),
      tool("m", "scarn-submit-step-findings"),
    ];

    expect(activitySummary(events)).toEqual({
      label:
        "Ran 2 commands, read 4 files, searched 1 time, edited 1 file, used 1 tool",
      headline: null,
    });
  });

  test("reads as thinking with the last reasoning as headline", () => {
    const events = [
      reasoning("m", "**First idea**"),
      reasoning("m", "**Checking the index**"),
    ] as ActivityEvent[];

    expect(activitySummary(events)).toEqual({
      label: "Thought",
      headline: "Checking the index",
    });
  });
});
