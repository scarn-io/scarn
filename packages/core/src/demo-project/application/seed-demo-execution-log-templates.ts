import type {
  AppendLogLineInput,
  ConversationEvent,
} from "@scarn/core/tasks/task-log/contracts/task-log-contracts";

/**
 * Fabricated `conversation`-stream log-line templates for the demo seed
 * (`seed-demo-fabricated-step-content.ts` pairs each burst with the result
 * payload its step is completed with). Split out of `seed-demo-execution.ts`
 * to stay under the repo's per-file line limit — these are pure,
 * dependency-free string/JSON builders with no application logic of their own.
 */

/**
 * A fabricated agent "turn" on the `conversation` stream: a `message` event
 * establishing the assistant-authored message, followed by a `text` event
 * carrying its content. The frontend groups conversation events by message id
 * (`conversation-view.tsx`'s `groupByMessage`) and only renders a group once
 * it has a `message` event plus a body (text/reasoning/tool) event, so both
 * lines are required for a turn to show up at all.
 */
const conversationTurn = (
  seqStart: number,
  ts: string,
  createdMs: number,
  messageId: string,
  partId: string,
  text: string,
): AppendLogLineInput[] => {
  const message: ConversationEvent = {
    kind: "message",
    id: messageId,
    role: "assistant",
    createdMs,
  };
  const textPart: ConversationEvent = {
    kind: "text",
    messageId,
    partId,
    role: "assistant",
    text,
  };
  return [
    {
      seq: seqStart,
      stream: "conversation",
      ts,
      content: JSON.stringify(message),
      level: "info",
    },
    {
      seq: seqStart + 1,
      stream: "conversation",
      ts,
      content: JSON.stringify(textPart),
      level: "info",
    },
  ];
};

/**
 * A single fabricated `tool` `ConversationEvent`, grouped under an existing
 * turn's `messageId` (per `conversation-view.tsx`'s `groupByMessage`, a
 * message can carry text and tool calls together). Kept deliberately short —
 * these are light-touch demo fixtures, not real captured transcripts.
 */
const toolEvent = (
  seq: number,
  ts: string,
  event: Omit<Extract<ConversationEvent, { kind: "tool" }>, "kind">,
): AppendLogLineInput => ({
  seq,
  stream: "conversation",
  ts,
  content: JSON.stringify({ kind: "tool", ...event }),
  level: "info",
});

/** The claim-confirmation + AI-server-boot + first-turn prefix shared by every log burst. */
const openingBurstLines = (
  stepTitle: string,
  at: (offsetMs: number) => string,
  atMs: (offsetMs: number) => number,
): AppendLogLineInput[] => [
  {
    seq: 0,
    stream: "worker",
    ts: at(0),
    content: `Claimed task for "${stepTitle}".`,
    level: "info",
  },
  {
    seq: 1,
    stream: "ai-server",
    ts: at(150),
    content: "Starting OpenCode AI server...",
    level: "info",
  },
  ...conversationTurn(
    2,
    at(900),
    atMs(900),
    "msg-1",
    "part-1",
    `Reading work item details for "${stepTitle}".`,
  ),
];

/**
 * Log lines for a step that reproduced the bug and wrote up a fix plan.
 * `withToolEvents` splices a single fabricated `tool` event (a short bash
 * call) into the "reproduced" turn, giving that item's Agent tab a `ToolCard`.
 */
export const succeededLogLines = (
  stepTitle: string,
  now: Date,
  withToolEvents: boolean,
): AppendLogLineInput[] => {
  const atMs = (offsetMs: number) => now.getTime() + offsetMs;
  const at = (offsetMs: number) => new Date(atMs(offsetMs)).toISOString();
  const lines: AppendLogLineInput[] = [
    ...openingBurstLines(stepTitle, at, atMs),
    ...conversationTurn(
      4,
      at(4200),
      atMs(4200),
      "msg-2",
      "part-2",
      "Reproduced the reported behavior and identified the root cause.",
    ),
  ];
  let nextSeq = 6;
  if (withToolEvents) {
    lines.push(
      toolEvent(nextSeq, at(4400), {
        messageId: "msg-2",
        partId: "part-2-tool",
        callId: "call-1",
        tool: "bash",
        status: "completed",
        title: "Reproducing the reported behavior",
        input: { command: "bun test --filter reported-issue" },
        output: "✓ reproduced: assertion failed at line 42 as expected",
      }),
    );
    nextSeq += 1;
  }
  lines.push(
    ...conversationTurn(
      nextSeq,
      at(6100),
      atMs(6100),
      "msg-3",
      "part-3",
      "Wrote up findings and a recommended fix.",
    ),
    {
      seq: nextSeq + 2,
      stream: "worker",
      ts: at(6300),
      content: "Step completed successfully.",
      level: "info",
    },
  );
  return lines;
};

/**
 * Log lines for a step whose agent read the ticket and reported `summary`,
 * with no reproduction narrative (e.g. an intake assessment).
 */
export const assessmentLogLines = (
  stepTitle: string,
  now: Date,
  summary: string,
): AppendLogLineInput[] => {
  const atMs = (offsetMs: number) => now.getTime() + offsetMs;
  const at = (offsetMs: number) => new Date(atMs(offsetMs)).toISOString();
  return [
    ...openingBurstLines(stepTitle, at, atMs),
    ...conversationTurn(4, at(2600), atMs(2600), "msg-2", "part-2", summary),
    {
      seq: 6,
      stream: "worker",
      ts: at(2800),
      content: "Step completed successfully.",
      level: "info",
    },
  ];
};

/**
 * Log lines for a step that failed partway through. `withToolEvents` splices
 * a single fabricated `tool` event (a bash call that itself errors, matching
 * the step's overall failure) into the "attempting to reproduce" turn.
 */
export const failedLogLines = (
  stepTitle: string,
  now: Date,
  withToolEvents: boolean,
): AppendLogLineInput[] => {
  const atMs = (offsetMs: number) => now.getTime() + offsetMs;
  const at = (offsetMs: number) => new Date(atMs(offsetMs)).toISOString();
  const lines: AppendLogLineInput[] = [
    ...openingBurstLines(stepTitle, at, atMs),
    ...conversationTurn(
      4,
      at(3400),
      atMs(3400),
      "msg-2",
      "part-2",
      "Attempting to reproduce the reported behavior in a local workspace.",
    ),
  ];
  let nextSeq = 6;
  if (withToolEvents) {
    lines.push(
      toolEvent(nextSeq, at(3600), {
        messageId: "msg-2",
        partId: "part-2-tool",
        callId: "call-1",
        tool: "bash",
        status: "error",
        title: "Starting local dev environment",
        input: { command: "bun run dev -- --health-check" },
        error: "Timed out waiting for http://localhost:3000 to become healthy.",
      }),
    );
    nextSeq += 1;
  }
  lines.push(
    {
      seq: nextSeq,
      stream: "worker",
      ts: at(5200),
      content:
        "Health check failed: dev server did not become ready within the configured timeout.",
      level: "error",
    },
    {
      seq: nextSeq + 1,
      stream: "worker",
      ts: at(5250),
      content:
        "Step failed: unable to reproduce — environment did not come up.",
      level: "error",
    },
  );
  return lines;
};
