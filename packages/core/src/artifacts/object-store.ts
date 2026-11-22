/**
 * Durable object storage port (the "cold" archive tier for step logs and,
 * later, other binary artifacts).
 *
 * This is intentionally minimal and provider-agnostic. The only production
 * adapter today is {@link S3ObjectStore} (which targets any S3-compatible
 * backend: real AWS S3 in the cloud, RustFS/MinIO/LocalStack locally). Tests
 * use an in-memory adapter.
 */

export type PutObjectInput = {
  key: string;
  body: Uint8Array | string;
  contentType?: string | undefined;
  /**
   * When true the adapter gzip-compresses the body at rest and tags the object
   * with `Content-Encoding: gzip`. This shrinks storage, egress, and the metered
   * byte size (which reflects the bytes actually stored/transferred). Browsers
   * and HTTP clients fetching via a presigned URL decompress transparently;
   * {@link ObjectStore.getObject} returns the original (decompressed) bytes.
   */
  compress?: boolean | undefined;
};

export type GetObjectResult = {
  body: Uint8Array;
  contentType: string | undefined;
  sizeBytes: number;
};

export interface ObjectStore {
  /**
   * Write (or overwrite) an object. Returns the stored byte size (post-
   * compression when {@link PutObjectInput.compress} is set), which is the value
   * to meter for storage/transfer accounting.
   */
  putObject(input: PutObjectInput): Promise<{ sizeBytes: number }>;
  /**
   * Read an object's full body, or null when the key does not exist. Objects
   * stored with `Content-Encoding: gzip` are decompressed so callers always see
   * the original bytes. An aborted `signal` rejects the read.
   */
  getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<GetObjectResult | null>;
  /**
   * Mint a short-lived presigned GET URL for an object so a browser can read
   * it directly without proxying bytes through the API. Adapters that cannot
   * presign (e.g. the in-memory test store) may return null, signalling the
   * caller to fall back to proxying via {@link getObject}.
   */
  getPresignedGetUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null>;
  /**
   * Mint a short-lived presigned PUT URL for a key so a client can upload
   * directly to the store without proxying the bytes through the API. When
   * provided, `contentType` is bound into the signature so the eventual upload
   * must send a matching `Content-Type`. Adapters that cannot presign (e.g. the
   * in-memory test store) may return null.
   */
  getPresignedPutUrl(
    key: string,
    expiresInSeconds: number,
    contentType?: string,
  ): Promise<string | null>;
  /**
   * Delete an object. Idempotent: deleting an already-absent key must not
   * throw (mirrors S3's own delete-is-idempotent semantics).
   */
  deleteObject(key: string): Promise<void>;
  /**
   * Delete every object whose key starts with `prefix`, returning how many
   * were deleted. Idempotent: an empty prefix range is not an error. Throws
   * when any object could not be deleted, so callers can retry.
   */
  deletePrefix(prefix: string): Promise<{ deletedCount: number }>;
}
