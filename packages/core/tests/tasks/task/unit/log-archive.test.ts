import { describe, expect } from "bun:test";
import { shouldArchiveRunLog } from "@/tasks/task/domain/log-archive";
import { concurrentTest } from "tests/utils";

const userId = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";

describe("shouldArchiveRunLog", () => {
  concurrentTest.each([
    ["always", "succeeded", null, true],
    ["always", "failed", null, true],
    ["on-failure", "succeeded", null, false],
    ["on-failure", "succeeded", userId, true],
    ["on-failure", "failed", null, true],
    ["on-failure", "timeout", null, true],
    ["on-failure", "cancelled", null, true],
  ] as const)(
    "%s, a %s run started by %p → %p",
    (logArchive, runStatus, startedByUserId, expected) => {
      expect(
        shouldArchiveRunLog({ logArchive, runStatus, startedByUserId }),
      ).toBe(expected);
    },
  );
});
