import { z } from "zod";
import { isUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";

const cursorSchema = z.strictObject({
  version: z.literal(1),
  workItemId: z.string().refine(isUuidV7),
  isPinned: z.boolean(),
  createdAt: z.iso.datetime({ precision: 6 }),
  id: z.string().refine(isUuidV7),
});

export type WorkItemCommentPageCursor = z.infer<typeof cursorSchema>;

export const encodeWorkItemCommentPageCursor = (
  cursor: WorkItemCommentPageCursor,
): string =>
  Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString("base64url");

export const decodeWorkItemCommentPageCursor = (
  value: string,
  workItemId: UuidV7,
): WorkItemCommentPageCursor => {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error("Invalid cursor encoding");
    }
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      throw new Error("Noncanonical cursor encoding");
    }
    const cursor = cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
    if (cursor.workItemId !== workItemId) {
      throw new Error("Cursor belongs to another work item");
    }
    return cursor;
  } catch {
    throw new CoreValidationError(
      "Invalid work item comments cursor",
      "INVALID_WORK_ITEM_COMMENTS_CURSOR",
    );
  }
};
