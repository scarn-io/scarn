import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import {
  parseCapturedLogLines,
  reanchorCapturedLogLines,
} from "@/demo-project/application/replay-captured-log";
import {
  conversationEventSchema,
  type LogLineContract,
} from "@/tasks/task-log/contracts/task-log-contracts";

const FIXTURE_PATH = path.join(
  import.meta.dir,
  "../../../src/demo-project/fixtures/flagship/coupon-double-apply/reproduce-in-browser.log.jsonl",
);

const line = (overrides: Partial<LogLineContract>): LogLineContract => ({
  seq: 0,
  stream: "worker",
  ts: "2026-01-01T00:00:00.000Z",
  content: "hello",
  level: "info",
  ...overrides,
});

describe("parseCapturedLogLines", () => {
  concurrentTest(
    "parses the checked-in flagship fixture into exactly 469 valid lines, with the known per-stream split",
    () => {
      const raw = readFileSync(FIXTURE_PATH, "utf8");

      const lines = parseCapturedLogLines(raw);

      expect(lines).toHaveLength(469);

      const countsByStream = new Map<string, number>();
      for (const parsedLine of lines) {
        countsByStream.set(
          parsedLine.stream,
          (countsByStream.get(parsedLine.stream) ?? 0) + 1,
        );
      }
      expect(countsByStream.get("worker")).toBe(105);
      expect(countsByStream.get("ai-server")).toBe(1);
      expect(countsByStream.get("conversation")).toBe(363);
    },
  );

  concurrentTest(
    "every conversation line's content validates against the ConversationEvent union",
    () => {
      const raw = readFileSync(FIXTURE_PATH, "utf8");
      const lines = parseCapturedLogLines(raw);
      const conversationLines = lines.filter(
        (parsedLine) => parsedLine.stream === "conversation",
      );

      expect(conversationLines).toHaveLength(363);

      for (const conversationLine of conversationLines) {
        const parsedContent: unknown = JSON.parse(conversationLine.content);
        const result = conversationEventSchema.safeParse(parsedContent);
        expect(result.success).toBe(true);
      }
    },
  );

  concurrentTest("throws on a line that is not valid JSON", () => {
    expect(() =>
      parseCapturedLogLines(
        '{"seq":0,"stream":"worker","ts":"2026-01-01T00:00:00.000Z","content":"ok","level":"info"}\nnot json at all',
      ),
    ).toThrow();
  });

  concurrentTest(
    "throws on a line missing a required field (fails logLineSchema)",
    () => {
      expect(() =>
        parseCapturedLogLines(
          JSON.stringify({
            seq: 0,
            stream: "worker",
            content: "missing ts and level",
          }),
        ),
      ).toThrow();
    },
  );

  concurrentTest("skips blank lines and trims surrounding whitespace", () => {
    const raw = `\n  ${JSON.stringify(line({ seq: 1 }))}  \n\n`;

    const lines = parseCapturedLogLines(raw);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.seq).toBe(1);
  });
});

describe("reanchorCapturedLogLines", () => {
  concurrentTest("returns [] for an empty input", () => {
    expect(
      reanchorCapturedLogLines([], new Date("2026-06-01T00:00:00.000Z")),
    ).toEqual([]);
  });

  concurrentTest(
    "re-bases every line's offset from the first line onto `now`, passing seq/stream/content/level through unchanged",
    () => {
      const capturedLines: LogLineContract[] = [
        line({
          seq: 0,
          stream: "worker",
          ts: "2025-01-01T00:00:00.000Z",
          content: "first",
          level: "info",
        }),
        line({
          seq: 1,
          stream: "ai-server",
          ts: "2025-01-01T00:00:05.000Z", // +5s from first
          content: "second",
          level: "debug",
        }),
        line({
          seq: 2,
          stream: "conversation",
          ts: "2025-01-01T00:00:05.250Z", // +5.25s from first
          content: '{"kind":"session-error","message":"boom"}',
          level: "warn",
        }),
      ];
      const now = new Date("2026-06-01T12:00:00.000Z");

      const remapped = reanchorCapturedLogLines(capturedLines, now);

      expect(remapped).toHaveLength(3);
      expect(remapped[0]?.ts).toBe(now.toISOString());
      expect(remapped[1]?.ts).toBe(
        new Date(now.getTime() + 5_000).toISOString(),
      );
      expect(remapped[2]?.ts).toBe(
        new Date(now.getTime() + 5_250).toISOString(),
      );

      for (const [index, capturedLine] of capturedLines.entries()) {
        const remappedLine = remapped[index];
        expect(remappedLine?.seq).toBe(capturedLine.seq);
        expect(remappedLine?.stream).toBe(capturedLine.stream);
        expect(remappedLine?.content).toBe(capturedLine.content);
        expect(remappedLine?.level).toBe(capturedLine.level);
      }
    },
  );
});
