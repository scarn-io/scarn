import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import {
  ConversationEntity,
  ConversationNotWaitingError,
  type ConversationStatus,
} from "@/conversations/conversation/domain/conversation-entity";
import {
  CONVERSATION_MESSAGE_BODY_MAX_LENGTH,
  ConversationMessageEntity,
} from "@/conversations/conversation/domain/conversation-message-entity";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const earlier = new Date("2026-06-01T09:00:00.000Z");
const now = new Date("2026-06-01T09:05:00.000Z");

const conversationIn = (status: ConversationStatus) =>
  ConversationEntity.rehydrate({
    id: createUuidV7(),
    projectId: createUuidV7(),
    workItemId: createUuidV7(),
    status,
    createdAt: earlier,
    updatedAt: earlier,
    closedAt: status === "closed" ? earlier : null,
  });

const expectNotWaiting = (fn: () => unknown) => {
  expect(fn).toThrow(ConversationNotWaitingError);
};

const expectValidationCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    expect((error as CoreValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
};

describe("conversation entity", () => {
  concurrentTest("starts waiting for a person", () => {
    const conversation = ConversationEntity.start({
      projectId: createUuidV7(),
      workItemId: null,
      now,
    });
    expect(conversation).toMatchObject({
      status: "waiting_for_person",
      workItemId: null,
      createdAt: now,
      closedAt: null,
    });
  });

  concurrentTest(
    "accepts person messages while waiting or with a reply pending",
    () => {
      expect(
        conversationIn("waiting_for_person").acceptPersonMessage(now),
      ).toMatchObject({ status: "reply_pending", updatedAt: now });
      expect(
        conversationIn("reply_pending").acceptPersonMessage(now).status,
      ).toBe("reply_pending");
    },
  );

  concurrentTest.each(["agent_turn", "closed"] as const)(
    "refuses a person message in %s",
    (status) => {
      expectNotWaiting(() => conversationIn(status).acceptPersonMessage(now));
    },
  );

  concurrentTest.each(["agent_turn", "reply_pending", "closed"] as const)(
    "refuses an action without writing in %s",
    (status) => {
      expectNotWaiting(() => {
        conversationIn(status).assertWaitingForPerson();
      });
    },
  );

  concurrentTest("delivery gives the agent the floor", () => {
    expect(conversationIn("reply_pending").deliver(now).status).toBe(
      "agent_turn",
    );
    expect(conversationIn("closed").deliver(now).status).toBe("closed");
  });

  concurrentTest(
    "the agent ending its turn waits for a person, unless closed",
    () => {
      expect(conversationIn("agent_turn").awaitPerson(now)).toMatchObject({
        status: "waiting_for_person",
        updatedAt: now,
      });
      expectNotWaiting(() => conversationIn("closed").awaitPerson(now));
    },
  );

  concurrentTest("closing is idempotent", () => {
    const closed = conversationIn("reply_pending").close(now);
    expect(closed).toMatchObject({ status: "closed", closedAt: now });
    expect(closed.close(new Date("2026-06-02T00:00:00.000Z")).closedAt).toEqual(
      now,
    );
  });

  concurrentTest(
    "retry reopens a closed conversation and allows the next hand-over",
    () => {
      const reopened = conversationIn("closed").reopenForRetry(now);
      expect(reopened).toMatchObject({
        status: "agent_turn",
        closedAt: null,
        updatedAt: now,
      });
      expect(reopened.awaitPerson(now).status).toBe("waiting_for_person");
    },
  );

  concurrentTest("retry keeps a turn that was never delivered pending", () => {
    expect(conversationIn("reply_pending").reopenForRetry(now).status).toBe(
      "reply_pending",
    );
  });

  concurrentTest(
    "a repo conversation opens with its first turn pending and no work item",
    () => {
      const projectId = createUuidV7();
      expect(ConversationEntity.open({ projectId, now })).toMatchObject({
        projectId,
        workItemId: null,
        status: "reply_pending",
        createdAt: now,
        closedAt: null,
      });
    },
  );
});

describe("conversation message entity", () => {
  const conversationId = createUuidV7();

  concurrentTest("trims the body", () => {
    expect(
      ConversationMessageEntity.person({
        conversationId,
        authorUserId: createUuidV7(),
        body: "  Target v2.  ",
      }).body,
    ).toBe("Target v2.");
  });

  concurrentTest("requires a body", () => {
    expectValidationCode(
      () =>
        ConversationMessageEntity.agent({
          conversationId,
          taskRunId: createUuidV7(),
          body: "   ",
        }),
      "CONVERSATION_MESSAGE_BODY_REQUIRED",
    );
  });

  concurrentTest("caps the body length", () => {
    expectValidationCode(
      () =>
        ConversationMessageEntity.person({
          conversationId,
          authorUserId: createUuidV7(),
          body: "x".repeat(CONVERSATION_MESSAGE_BODY_MAX_LENGTH + 1),
        }),
      "CONVERSATION_MESSAGE_BODY_TOO_LONG",
    );
  });

  concurrentTest("only an agent message has no author user", () => {
    const agent = ConversationMessageEntity.agent({
      conversationId,
      taskRunId: createUuidV7(),
      body: "Which version?",
    });
    expectValidationCode(
      () =>
        ConversationMessageEntity.rehydrate({
          ...agent.toJSON(),
          authorUserId: createUuidV7(),
        }),
      "CONVERSATION_MESSAGE_AUTHOR_INVALID",
    );
    expectValidationCode(
      () =>
        ConversationMessageEntity.rehydrate({
          ...agent.toJSON(),
          authorKind: "system",
        }),
      "CONVERSATION_MESSAGE_AUTHOR_INVALID",
    );
  });
});
