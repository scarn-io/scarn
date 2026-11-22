import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import {
  TASK_MESSAGE_BODY_MAX_LENGTH,
  TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH,
  TaskMessageEntity,
} from "@/tasks/task-message/domain/task-message-entity";
import { concurrentTest } from "tests/utils";

const baseProps = () => ({
  taskId: createUuidV7(),
  authorUserId: createUuidV7(),
  body: "Look at why the cart lock is never released.",
});

const codeOf = (build: () => object) => {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreValidationError);
    return (error as CoreValidationError).code;
  }
  return null;
};

describe("task message entity", () => {
  concurrentTest("trims the body and quote text", () => {
    const message = TaskMessageEntity.create({
      ...baseProps(),
      body: "  Look at the lock.  ",
      quoteText: "  Reproduces 9/10 under load. ",
    });

    expect(message.body).toBe("Look at the lock.");
    expect(message.quoteText).toBe("Reproduces 9/10 under load.");
  });

  concurrentTest("treats a blank or missing quote text as none", () => {
    expect(TaskMessageEntity.create(baseProps()).quoteText).toBeNull();
    expect(
      TaskMessageEntity.create({ ...baseProps(), quoteText: "   " }).quoteText,
    ).toBeNull();
  });

  concurrentTest("rejects a blank body", () => {
    expect(
      codeOf(() => TaskMessageEntity.create({ ...baseProps(), body: "   " })),
    ).toBe("TASK_MESSAGE_BODY_REQUIRED");
  });

  concurrentTest("checks lengths after trimming", () => {
    const longestBody = "a".repeat(TASK_MESSAGE_BODY_MAX_LENGTH);
    const longestQuote = "q".repeat(TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH);

    expect(
      TaskMessageEntity.create({
        ...baseProps(),
        body: ` ${longestBody} `,
        quoteText: ` ${longestQuote} `,
      }).body,
    ).toBe(longestBody);
    expect(
      codeOf(() =>
        TaskMessageEntity.create({ ...baseProps(), body: `${longestBody}a` }),
      ),
    ).toBe("TASK_MESSAGE_BODY_TOO_LONG");
    expect(
      codeOf(() =>
        TaskMessageEntity.rehydrate({
          ...baseProps(),
          id: createUuidV7(),
          quoteText: `${longestQuote}q`,
        }),
      ),
    ).toBe("TASK_MESSAGE_QUOTE_TEXT_TOO_LONG");
  });
});
