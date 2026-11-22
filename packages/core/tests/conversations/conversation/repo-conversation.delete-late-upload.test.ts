/**
 * DB-backed coverage for an upload landing after its chat is deleted: a
 * presigned URL issued before the delete still works, so the object must
 * land under a prefix the scheduled storage sweep removes once `not_before`
 * passes (the sweep itself is in storage-sweep/integration).
 */
import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { storageSweeps } from "@/lib/db/schema";
import { storageSweepPrefixes } from "@/tasks/storage-sweep/domain/storage-sweep";
import { serialTest } from "tests/utils";
import {
  createRepoConversationHarness,
  PresigningObjectStore,
  SESSION_BYTES,
  unwrap,
} from "./repo-conversation-test-support";

describe("repo conversations: an upload after delete", () => {
  const objectStore = new PresigningObjectStore();
  const { h, remove, created, claim } = createRepoConversationHarness({
    objectStore,
  });

  serialTest(
    "an upload through a URL issued before the delete lands under a swept prefix",
    async () => {
      const chat = await created();
      const claimToken = await claim(chat.taskRunId);
      const upload = await h.apiClient.api["task-runs"]({
        taskRunId: chat.taskRunId,
      })["session-upload-url"].post(
        { claimToken, sizeBytes: SESSION_BYTES },
        { headers: h.requireSetup().headers },
      );
      const objectKey = upload.data?.objectKey ?? "";
      expect(objectKey).not.toBe("");

      await unwrap(remove(chat.conversationId));
      await objectStore.putObject({ key: objectKey, body: "late" });

      const [sweep] = await getDb()
        .select()
        .from(storageSweeps)
        .where(eq(storageSweeps.taskRunId, chat.taskRunId));
      expect(sweep).toBeDefined();
      expect(sweep?.notBefore.getTime()).toBeGreaterThan(
        h.appContext.timeProvider.now().getTime(),
      );
      const prefixes = storageSweepPrefixes({
        projectId: parseUuidV7(sweep?.projectId ?? ""),
        taskRunId: parseUuidV7(sweep?.taskRunId ?? ""),
      });
      expect(prefixes.some((prefix) => objectKey.startsWith(prefix))).toBe(
        true,
      );
    },
  );
});
