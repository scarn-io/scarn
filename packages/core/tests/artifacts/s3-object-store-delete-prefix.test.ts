import { describe, expect } from "bun:test";
import {
  ListObjectsV2Command,
  type DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  type ListObjectsV2CommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { concurrentTest } from "tests/utils";
import { S3ObjectStore } from "@/artifacts/infra/s3-object-store";

const CONFIG = {
  bucket: "scarn-test",
  region: "us-east-1",
  endpoint: undefined,
  accessKeyId: "key",
  secretAccessKey: "secret",
  forcePathStyle: true,
};

const S3_PAGE_SIZE = 1_000;

/**
 * A stub S3 API over a sorted key list that pages `ListObjectsV2` 1000 keys at
 * a time with key-positioned continuation tokens (like S3, so deleting a page
 * doesn't shift the next one) and records every `DeleteObjects` batch.
 */
const stubS3 = (
  initialKeys: string[],
  options: { failDeleteOf?: string } = {},
) => {
  const keys = new Set(initialKeys);
  const deleteBatches: string[][] = [];
  const send = (
    command: ListObjectsV2Command | DeleteObjectsCommand,
  ): Promise<
    Partial<ListObjectsV2CommandOutput | DeleteObjectsCommandOutput>
  > => {
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const after = command.input.ContinuationToken ?? "";
      const matching = [...keys]
        .filter((key) => key.startsWith(prefix) && key > after)
        .sort();
      const page = matching.slice(0, S3_PAGE_SIZE);
      const truncated = matching.length > S3_PAGE_SIZE;
      return Promise.resolve({
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: truncated,
        NextContinuationToken: truncated ? page.at(-1) : undefined,
      });
    }
    const batch = (command.input.Delete?.Objects ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [object.Key],
    );
    deleteBatches.push(batch);
    const errors = batch
      .filter((key) => key === options.failDeleteOf)
      .map((Key) => ({ Key, Code: "AccessDenied", Message: "Access Denied" }));
    for (const key of batch) {
      if (key !== options.failDeleteOf) {
        keys.delete(key);
      }
    }
    return Promise.resolve({ Errors: errors });
  };
  return {
    client: { send } as unknown as S3Client,
    keys,
    deleteBatches,
  };
};

describe("S3ObjectStore.deletePrefix", () => {
  concurrentTest(
    "pages through more than 1000 keys and deletes in batches of at most 1000",
    async () => {
      const runKeys = Array.from(
        { length: 2_345 },
        (_, index) =>
          `artifacts/p/run-1/file-${String(index).padStart(5, "0")}`,
      );
      const s3 = stubS3([...runKeys, "artifacts/p/run-2/keep"]);
      const store = new S3ObjectStore(CONFIG, s3.client);

      const { deletedCount } = await store.deletePrefix("artifacts/p/run-1/");

      expect(deletedCount).toBe(runKeys.length);
      expect(s3.deleteBatches.map((batch) => batch.length)).toEqual([
        1_000, 1_000, 345,
      ]);
      expect([...s3.keys]).toEqual(["artifacts/p/run-2/keep"]);
    },
  );

  concurrentTest("does nothing for an empty prefix range", async () => {
    const s3 = stubS3(["tasks/other/session.json"]);
    const store = new S3ObjectStore(CONFIG, s3.client);

    expect(await store.deletePrefix("tasks/run-1/")).toEqual({
      deletedCount: 0,
    });
    expect(s3.deleteBatches).toEqual([]);
  });

  concurrentTest("throws when S3 reports a per-key delete error", async () => {
    const s3 = stubS3(["tasks/run-1/a", "tasks/run-1/b"], {
      failDeleteOf: "tasks/run-1/b",
    });
    const store = new S3ObjectStore(CONFIG, s3.client);

    let caught: Error | null = null;
    try {
      await store.deletePrefix("tasks/run-1/");
    } catch (error) {
      caught = error instanceof Error ? error : null;
    }

    expect(caught?.message).toContain("AccessDenied");
  });
});
