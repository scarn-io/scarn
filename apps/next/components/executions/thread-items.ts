/**
 * Turns a run's `ConversationEvent`s into what the step thread renders:
 * agent text as narration, the reasoning and tool calls between two pieces of
 * narration folded into one activity row, and session errors on their own.
 *
 * Events carry no timestamps of their own, so timing comes from the
 * `createdMs` of the message each part belongs to.
 */
import type { ConversationEvent } from "@scarn/api/frontend-contracts";

export type ActivityEvent = Extract<
  ConversationEvent,
  { kind: "tool" | "reasoning" }
>;

type ToolEvent = Extract<ConversationEvent, { kind: "tool" }>;

export type NarrationItem = {
  type: "narration";
  id: string;
  text: string;
  atMs: number | null;
};

export type ActivityItem = {
  type: "activity";
  id: string;
  events: ActivityEvent[];
  /** When the first message in the group was created. */
  startMs: number | null;
  /**
   * When the message that closed the group (the next narration) was created.
   * `null` for a trailing group; the caller ends it at the run's completion
   * or now.
   */
  endMs: number | null;
  /** The run is still going and this is the last thing it did. */
  active: boolean;
};

export type SessionErrorItem = {
  type: "session-error";
  id: string;
  message: string;
};

export type ThreadItem = NarrationItem | ActivityItem | SessionErrorItem;

type MessagePart = Extract<
  ConversationEvent,
  { kind: "text" | "reasoning" | "tool" }
>;

type Segment =
  | { kind: "message"; messageId: string; parts: MessagePart[] }
  | { kind: "session-error"; message: string };

/**
 * Within each message, the narration is what the agent says it's about to
 * do, so it goes first; the reasoning and tool calls that follow fold into
 * the next activity row.
 */
const PART_ORDER: Record<MessagePart["kind"], number> = {
  text: 0,
  reasoning: 1,
  tool: 2,
};

/** Groups events by message in first-seen order, keeping session errors in place. */
function segmentEvents(events: ConversationEvent[]): {
  segments: Segment[];
  createdMs: Map<string, number>;
} {
  const segments: Segment[] = [];
  const byMessage = new Map<string, MessagePart[]>();
  const createdMs = new Map<string, number>();
  const partsFor = (messageId: string) => {
    let parts = byMessage.get(messageId);
    if (!parts) {
      parts = [];
      byMessage.set(messageId, parts);
      segments.push({ kind: "message", messageId, parts });
    }
    return parts;
  };
  for (const event of events) {
    switch (event.kind) {
      case "message":
        createdMs.set(event.id, event.createdMs);
        partsFor(event.id);
        break;
      case "text":
      case "reasoning":
      case "tool":
        partsFor(event.messageId).push(event);
        break;
      case "session-error":
        segments.push({ kind: "session-error", message: event.message });
        break;
      case "step-finish":
        break;
    }
  }
  return { segments, createdMs };
}

const orderParts = (parts: MessagePart[]): MessagePart[] =>
  parts
    .map((part, index) => ({ part, index }))
    .sort(
      (a, b) =>
        PART_ORDER[a.part.kind] - PART_ORDER[b.part.kind] || a.index - b.index,
    )
    .map(({ part }) => part);

/**
 * The run's opening user prompt: the text of the first user message. The
 * thread shows it on the start line rather than as an item.
 */
export function startPrompt(events: ConversationEvent[]): string | null {
  const first = events.find(
    (event): event is Extract<ConversationEvent, { kind: "text" }> =>
      event.kind === "text" && event.role === "user",
  );
  return first?.text.trim() ? first.text : null;
}

/**
 * Builds the thread items for one run. User text is left out: the first
 * user prompt becomes the run's start line (see {@link startPrompt}) and the
 * person's own message comes from the thread endpoint. `running` marks a
 * trailing activity row as active.
 */
export function buildThreadItems(
  events: ConversationEvent[],
  { running }: { running: boolean },
): ThreadItem[] {
  const { segments, createdMs } = segmentEvents(events);
  const items: ThreadItem[] = [];
  let group: Omit<ActivityItem, "endMs" | "active"> | null = null;
  const flush = (endMs: number | null) => {
    if (group) items.push({ ...group, endMs, active: false });
    group = null;
  };

  for (const segment of segments) {
    if (segment.kind === "session-error") {
      flush(null);
      items.push({
        type: "session-error",
        id: `session-error-${String(items.length)}`,
        message: segment.message,
      });
      continue;
    }
    const atMs = createdMs.get(segment.messageId) ?? null;
    for (const part of orderParts(segment.parts)) {
      if (part.kind === "text") {
        if (part.role === "user" || !part.text.trim()) continue;
        flush(atMs);
        items.push({
          type: "narration",
          id: part.partId,
          text: part.text,
          atMs,
        });
        continue;
      }
      if (part.kind === "reasoning" && !part.text.trim()) continue;
      group ??= {
        type: "activity",
        id: `activity-${part.partId}`,
        events: [],
        startMs: atMs,
      };
      group.events.push(part);
    }
  }
  flush(null);

  const last = items.at(-1);
  if (running && last?.type === "activity") {
    items[items.length - 1] = { ...last, active: true };
  }
  return items;
}

export type Fold = {
  /** Narrations folded behind the "N earlier updates" row. */
  hidden: number;
  /** Index of the first item still shown. */
  visibleFrom: number;
  /** Time covered by the folded items, when the messages carry it. */
  durationMs: number | null;
};

/** Fold once a run has more narrations than this. */
const FOLD_OVER = 5;
/** Narrations left visible after folding. */
const KEEP_NARRATIONS = 3;

const itemMs = (item: ThreadItem): number | null => {
  switch (item.type) {
    case "narration":
      return item.atMs;
    case "activity":
      return item.startMs;
    case "session-error":
      return null;
  }
};

/**
 * "N earlier updates": once a run has more than a handful of narrations,
 * keep only the last few (and everything after the first one shown).
 * Returns `null` when there is nothing worth folding.
 */
export function foldItems(
  items: ThreadItem[],
  keepNarrations: number = KEEP_NARRATIONS,
): Fold | null {
  const narrations = items.flatMap((item, index) =>
    item.type === "narration" ? [index] : [],
  );
  if (narrations.length <= FOLD_OVER) return null;
  const visibleFrom = narrations[narrations.length - keepNarrations];
  if (visibleFrom === undefined) return null;
  const hidden = narrations.filter((index) => index < visibleFrom).length;
  if (hidden < 2) return null;
  const first = items[0];
  const firstShown = items[visibleFrom];
  const startMs = first ? itemMs(first) : null;
  const endMs = firstShown ? itemMs(firstShown) : null;
  return {
    hidden,
    visibleFrom,
    durationMs: startMs !== null && endMs !== null ? endMs - startMs : null,
  };
}

const plural = (n: number, word: string) =>
  `${String(n)} ${word}${n === 1 ? "" : "s"}`;

/**
 * The muted label for an activity row ("Read 4 files, ran 2 commands") and
 * the latest reasoning headline, if any.
 */
export function activitySummary(events: ActivityEvent[]): {
  label: string;
  headline: string | null;
} {
  const tools = events.filter(
    (event): event is ToolEvent => event.kind === "tool",
  );
  const count = (names: string[]) =>
    tools.filter((tool) => names.includes(tool.tool)).length;
  const commands = count(["bash"]);
  const reads = count(["read"]);
  const searches = count(["glob", "grep"]);
  const edits = count(["edit", "write"]);
  const other = tools.length - commands - reads - searches - edits;
  const parts = [
    commands ? `ran ${plural(commands, "command")}` : "",
    reads ? `read ${plural(reads, "file")}` : "",
    searches ? `searched ${plural(searches, "time")}` : "",
    edits ? `edited ${plural(edits, "file")}` : "",
    other ? `used ${plural(other, "tool")}` : "",
  ].filter(Boolean);
  const label = parts.length ? parts.join(", ") : "Thought";
  const lastReasoning = events
    .filter((event) => event.kind === "reasoning")
    .at(-1);
  const headline = lastReasoning
    ? lastReasoning.text.replace(/\*\*/g, "").trim() || null
    : null;
  return { label: label.charAt(0).toUpperCase() + label.slice(1), headline };
}
