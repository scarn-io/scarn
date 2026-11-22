import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  decodeWorkItemCommentPageCursor,
  encodeWorkItemCommentPageCursor,
} from "@scarn/core/work-items/work-item-comment/application/work-item-comment-page-cursor";

describe("work item comment page cursors", () => {
  const workItemId = createUuidV7();
  const cursor = {
    version: 1 as const,
    workItemId,
    isPinned: true,
    createdAt: "2026-11-08T12:34:56.123456Z",
    id: createUuidV7(),
  };
  const encodeRaw = (value: Record<string, string | number | boolean>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  test("preserves the complete keyset tuple, including SQL microseconds", () => {
    expect(
      decodeWorkItemCommentPageCursor(
        encodeWorkItemCommentPageCursor(cursor),
        workItemId,
      ),
    ).toEqual(cursor);
  });

  test("accepts a tuple independently of the continued existence of its anchor", () => {
    const encoded = encodeWorkItemCommentPageCursor(cursor);
    expect(decodeWorkItemCommentPageCursor(encoded, workItemId).id).toBe(
      cursor.id,
    );
  });

  test("rejects another work item's cursor with the same validation error", () => {
    expect(() =>
      decodeWorkItemCommentPageCursor(
        encodeWorkItemCommentPageCursor(cursor),
        createUuidV7(),
      ),
    ).toThrow(CoreValidationError);
  });

  test("rejects malformed encodings and invalid or noncanonical payloads consistently", () => {
    const invalid = [
      "",
      "!!!",
      "a".repeat(1025),
      "e30=",
      "e31",
      Buffer.from("not json").toString("base64url"),
      encodeRaw({ ...cursor, version: 2 }),
      encodeRaw({ ...cursor, extra: true }),
      encodeRaw({ ...cursor, id: "not a uuid" }),
      encodeRaw({ ...cursor, workItemId: ` ${workItemId}` }),
      encodeRaw({ ...cursor, isPinned: "true" }),
      encodeRaw({ ...cursor, createdAt: "2026-11-08T12:34:56.123Z" }),
      encodeRaw({ ...cursor, createdAt: "2026-99-08T12:34:56.123456Z" }),
    ];
    for (const value of invalid) {
      try {
        decodeWorkItemCommentPageCursor(value, workItemId);
        throw new Error("Expected validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CoreValidationError);
        expect((error as CoreValidationError).code).toBe(
          "INVALID_WORK_ITEM_COMMENTS_CURSOR",
        );
        expect((error as CoreValidationError).status).toBe(422);
      }
    }
  });
});
