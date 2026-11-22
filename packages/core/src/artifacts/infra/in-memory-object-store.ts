import { gunzipSync, gzipSync } from "node:zlib";
import type {
  GetObjectResult,
  ObjectStore,
  PutObjectInput,
} from "@scarn/core/artifacts/object-store";

type StoredObject = {
  body: Uint8Array;
  contentType: string | undefined;
  contentEncoding: "gzip" | undefined;
};

/**
 * In-memory {@link ObjectStore} for tests and environments without real object
 * storage. Cannot presign, so {@link getPresignedGetUrl} and
 * {@link getPresignedPutUrl} return null to make callers fall back to proxying
 * bytes through {@link getObject} / {@link putObject}.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async putObject(input: PutObjectInput): Promise<{ sizeBytes: number }> {
    const raw =
      typeof input.body === "string"
        ? new TextEncoder().encode(input.body)
        : input.body;
    const body = input.compress ? gzipSync(raw) : raw;
    this.objects.set(input.key, {
      body,
      contentType: input.contentType,
      contentEncoding: input.compress ? "gzip" : undefined,
    });
    // Report the stored (post-compression) size to mirror the S3 adapter.
    return { sizeBytes: body.byteLength };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getObject(key: string): Promise<GetObjectResult | null> {
    const stored = this.objects.get(key);
    if (!stored) {
      return null;
    }
    const body =
      stored.contentEncoding === "gzip" ? gunzipSync(stored.body) : stored.body;
    return {
      body,
      contentType: stored.contentType,
      sizeBytes: body.byteLength,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getPresignedGetUrl(): Promise<string | null> {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getPresignedPutUrl(): Promise<string | null> {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deletePrefix(prefix: string): Promise<{ deletedCount: number }> {
    const keys = [...this.objects.keys()].filter((key) =>
      key.startsWith(prefix),
    );
    for (const key of keys) {
      this.objects.delete(key);
    }
    return { deletedCount: keys.length };
  }
}
