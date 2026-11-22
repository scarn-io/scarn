import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ConversationMessageEntity } from "@/conversations/conversation/domain/conversation-message-entity";
import {
  buildChatPromptLines,
  buildChatRestoredMessage,
  buildConversationPromptLines,
  currentTurnStart,
  keepChatTranscriptWithinBudget,
  buildRestoredSessionMessage,
  CONVERSATION_PROMPT_BUDGET,
  keepNewestWithinBudget,
  NO_ANSWER_TEXT,
  type ConversationPromptEntry,
} from "@/tasks/task-run/application/task-run-worker-context-conversation";
import { concurrentTest } from "tests/utils";

const agent = (body: string): ConversationPromptEntry => ({
  authorKind: "agent",
  author: "Scarn (you)",
  body,
});
const person = (body: string, author: string | null = "alex") => ({
  authorKind: "person" as const,
  author,
  body,
});
const system = (body: string): ConversationPromptEntry => ({
  authorKind: "system",
  author: "alex",
  body,
});

describe("buildRestoredSessionMessage", () => {
  concurrentTest("sends one reply per delivered message, oldest first", () => {
    expect(
      buildRestoredSessionMessage([
        person("Target v2; v1 is deprecated."),
        person("Keep the old flag.", "sam"),
      ]),
    ).toBe(
      "Reply from alex: Target v2; v1 is deprecated.\n\nReply from sam: Keep the old flag.",
    );
  });

  concurrentTest("sends the no-answer text for a continue", () => {
    expect(
      buildRestoredSessionMessage([
        system("alex chose to continue without a reply"),
      ]),
    ).toBe(NO_ANSWER_TEXT);
  });

  concurrentTest("names an unknown person generically", () => {
    expect(buildRestoredSessionMessage([person("Target v2.", null)])).toBe(
      "Reply from a person: Target v2.",
    );
  });
});

describe("buildConversationPromptLines", () => {
  concurrentTest("is empty for a Task that isn't a continuation", () => {
    expect(buildConversationPromptLines(null)).toEqual([]);
  });

  concurrentTest("lists agent and person messages, oldest first", () => {
    const lines = buildConversationPromptLines({
      delivered: [person("Target v2.\nNot v1.")],
      thread: [
        agent("Should the fix target v1 or v2?"),
        person("Target v2.\nNot v1."),
      ],
      omitted: 0,
      omittedAt: 0,
    });
    expect(lines).toEqual([
      "The conversation so far, oldest first:",
      "Scarn (you):",
      "    Should the fix target v1 or v2?",
      "alex:",
      "    Target v2.",
      "    Not v1.",
      "",
    ]);
  });

  concurrentTest(
    "notes omitted messages and a continue without a reply",
    () => {
      const lines = buildConversationPromptLines({
        delivered: [system("alex chose to continue without a reply")],
        thread: [agent("Should the fix target v1 or v2?")],
        omitted: 3,
        omittedAt: 0,
      });
      expect(lines).toEqual([
        "The conversation so far, oldest first:",
        "(3 earlier messages omitted)",
        "Scarn (you):",
        "    Should the fix target v1 or v2?",
        NO_ANSWER_TEXT,
        "",
      ]);
    },
  );
});

describe("keepNewestWithinBudget", () => {
  const conversationId = createUuidV7();
  const message = (size: number) =>
    ConversationMessageEntity.person({
      conversationId,
      authorUserId: createUuidV7(),
      body: "x".repeat(size),
    });

  concurrentTest("keeps everything within the budget", () => {
    const messages = [message(10), message(20)];
    expect(keepNewestWithinBudget(messages)).toEqual({
      kept: messages,
      omitted: 0,
    });
  });

  concurrentTest("keeps the newest and counts the dropped", () => {
    const half = CONVERSATION_PROMPT_BUDGET / 2;
    const messages = [message(10), message(half), message(half)];
    expect(keepNewestWithinBudget(messages)).toEqual({
      kept: messages.slice(1),
      omitted: 1,
    });
  });
});

describe("chat transcript", () => {
  const conversationId = createUuidV7();
  const asked = (body: string) =>
    ConversationMessageEntity.person({
      conversationId,
      authorUserId: createUuidV7(),
      body,
    });
  const answered = (body: string) =>
    ConversationMessageEntity.rehydrate({
      ...asked(body).toJSON(),
      authorKind: "agent",
      authorUserId: null,
    });

  concurrentTest(
    "the current turn is the person messages after the latest agent message",
    () => {
      expect(currentTurnStart([asked("q")])).toBe(0);
      expect(
        currentTurnStart([asked("q"), answered("a"), asked("r1"), asked("r2")]),
      ).toBe(2);
      expect(currentTurnStart([asked("q"), answered("a")])).toBe(2);
    },
  );

  concurrentTest(
    "a long transcript is cut to the budget but keeps the first question and the current turn",
    () => {
      const quarter = CONVERSATION_PROMPT_BUDGET / 4;
      const messages = [
        asked("first question"),
        answered("x".repeat(quarter)),
        asked("y".repeat(quarter)),
        answered("z".repeat(quarter)),
        asked("w".repeat(quarter)),
        asked("v".repeat(quarter)),
      ];
      const { kept, omitted } = keepChatTranscriptWithinBudget(messages, 4);
      expect(kept.map((each) => each.body)).toEqual([
        "first question",
        "z".repeat(quarter),
        "w".repeat(quarter),
        "v".repeat(quarter),
      ]);
      expect(omitted).toBe(2);
    },
  );

  concurrentTest(
    "keeps the current turn even when it alone is over the budget",
    () => {
      const messages = [
        asked("first question"),
        answered("a"),
        asked("x".repeat(CONVERSATION_PROMPT_BUDGET / 2)),
        asked("y".repeat(CONVERSATION_PROMPT_BUDGET / 2)),
      ];
      const { kept, omitted } = keepChatTranscriptWithinBudget(messages, 2);
      expect(kept.map((each) => each.body.slice(0, 1))).toEqual([
        "f",
        "x",
        "y",
      ]);
      expect(omitted).toBe(1);
    },
  );

  concurrentTest(
    "keeps a first question that is also the current turn once",
    () => {
      const messages = [asked("first question")];
      expect(keepChatTranscriptWithinBudget(messages, 0)).toEqual({
        kept: messages,
        omitted: 0,
      });
    },
  );

  concurrentTest(
    "notes omitted messages after the first question and points at the turn to answer",
    () => {
      const lines = buildChatPromptLines({
        delivered: [person("Which file?"), person("And the tests?")],
        thread: [
          person("How does checkout work?"),
          agent("Through the cart service."),
          person("Which file?"),
          person("And the tests?"),
        ],
        omitted: 2,
        omittedAt: 1,
      });
      expect(lines).toEqual([
        "The conversation so far, oldest first:",
        "alex:",
        "    How does checkout work?",
        "(2 earlier messages omitted)",
        "Scarn (you):",
        "    Through the cart service.",
        "alex:",
        "    Which file?",
        "alex:",
        "    And the tests?",
        "",
        "Answer the last 2 messages now; they came in since your previous answer.",
        "",
      ]);
    },
  );

  concurrentTest(
    "a restored chat session gets the current turn's replies",
    () => {
      expect(
        buildChatRestoredMessage({
          delivered: [person("Which file?")],
          thread: [],
          omitted: 0,
          omittedAt: 0,
        }),
      ).toBe("Reply from alex: Which file?");
    },
  );
});
