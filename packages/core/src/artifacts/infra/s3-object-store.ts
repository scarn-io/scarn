import { gunzipSync, gzipSync } from "node:zlib";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConfigurationError } from "@scarn/core/lib/errors";
import type {
  GetObjectResult,
  ObjectStore,
  PutObjectInput,
} from "@scarn/core/artifacts/object-store";

export type S3ObjectStoreConfig = {
  bucket: string;
  region: string;
  /**
   * Custom endpoint for S3-compatible backends (RustFS/MinIO/LocalStack).
   * Leave undefined to target real AWS S3.
   */
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`) is required by most local
   * S3-compatible servers; virtual-hosted style is the AWS default.
   */
  forcePathStyle: boolean;
};

/**
 * Reads S3 configuration from the environment. Returns null when no bucket is
 * configured so callers can degrade gracefully (e.g. skip log archival in
 * environments where object storage is not wired up yet).
 */
export const s3ObjectStoreConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): S3ObjectStoreConfig | null => {
  const bucket = env["S3_BUCKET"];
  if (!bucket) {
    return null;
  }
  const accessKeyId = env["S3_ACCESS_KEY_ID"];
  const secretAccessKey = env["S3_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) {
    throw new ConfigurationError(
      "S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing",
      "S3_CREDENTIALS_MISSING",
    );
  }
  return {
    bucket,
    region: env["S3_REGION"] ?? "us-east-1",
    endpoint: env["S3_ENDPOINT"],
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env["S3_FORCE_PATH_STYLE"] === "true",
  };
};

/**
 * Whether object storage is configured at all, i.e. whether `S3_BUCKET` is set.
 * Unlike {@link s3ObjectStoreConfigFromEnv} this never throws — it deliberately
 * does not validate credentials, so it is safe to call at module-evaluation
 * time to decide between a lazily-resolved store and no store.
 */
export const isS3ObjectStoreConfigured = (
  env: Record<string, string | undefined> = process.env,
): boolean => Boolean(env["S3_BUCKET"]);

const toUint8Array = (body: PutObjectInput["body"]): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

const GZIP_ENCODING = "gzip";

/**
 * Rejects with the signal's reason once it aborts. The SDK only honours its
 * `abortSignal` until response headers arrive, so streaming the body is
 * raced against it separately.
 */
const untilAborted = <T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
};

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  /** `client` is for tests that stub the S3 API; production builds its own. */
  constructor(config: S3ObjectStoreConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        forcePathStyle: config.forcePathStyle,
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async putObject(input: PutObjectInput): Promise<{ sizeBytes: number }> {
    const raw = toUint8Array(input.body);
    const body = input.compress ? gzipSync(raw) : raw;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: body,
        ...(input.contentType !== undefined
          ? { ContentType: input.contentType }
          : {}),
        ...(input.compress ? { ContentEncoding: GZIP_ENCODING } : {}),
      }),
    );
    // Report the stored size (post-compression) so storage/transfer accounting
    // reflects the actual bytes at rest.
    return { sizeBytes: body.byteLength };
  }

  async getObject(
    key: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<GetObjectResult | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: options.signal },
      );
      if (!response.Body) {
        return null;
      }
      const stored = await untilAborted(
        response.Body.transformToByteArray(),
        options.signal,
      );
      // Decompress transparently so callers proxying bytes always receive the
      // original content, regardless of how it was stored.
      const body =
        response.ContentEncoding === GZIP_ENCODING
          ? gunzipSync(stored)
          : stored;
      return {
        body,
        contentType: response.ContentType,
        sizeBytes: body.byteLength,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async getPresignedGetUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  async getPresignedPutUrl(
    key: string,
    expiresInSeconds: number,
    contentType?: string,
  ): Promise<string | null> {
    return await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(contentType !== undefined ? { ContentType: contentType } : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Lists the prefix one page (up to 1000 keys) at a time and deletes each page
   * with a single `DeleteObjects` call, which accepts at most 1000 keys.
   */
  async deletePrefix(prefix: string): Promise<{ deletedCount: number }> {
    let deletedCount = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken !== undefined
            ? { ContinuationToken: continuationToken }
            : {}),
        }),
      );
      const keys = (page.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [object.Key],
      );
      if (keys.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const errors = result.Errors ?? [];
        if (errors.length > 0) {
          const [first] = errors;
          throw new Error(
            `Failed to delete ${String(errors.length)} object(s) under ${prefix}: ${first?.Code ?? "unknown"} ${first?.Message ?? ""}`.trim(),
          );
        }
        deletedCount += keys.length;
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken !== undefined);
    return { deletedCount };
  }
}

/**
 * Wraps {@link S3ObjectStore} so that reading S3 configuration from the
 * environment (and constructing the S3 client) is deferred until the first
 * actual object-store operation.
 *
 * This keeps module import side-effect free: resolving the store at import time
 * (e.g. when Next.js evaluates a route module while collecting page data during
 * `next build`) must not throw just because credentials are absent in the build
 * environment. Any genuine misconfiguration (`S3_BUCKET` set but keys missing)
 * still surfaces — but only when the store is actually used to serve a request.
 */
export class LazyS3ObjectStore implements ObjectStore {
  private delegate: S3ObjectStore | null = null;

  constructor(
    private readonly resolveConfig: () => S3ObjectStoreConfig | null = () =>
      s3ObjectStoreConfigFromEnv(),
  ) {}

  private getDelegate(): S3ObjectStore {
    if (this.delegate === null) {
      const config = this.resolveConfig();
      if (config === null) {
        throw new ConfigurationError(
          "Object storage is not configured (S3_BUCKET is not set)",
          "S3_NOT_CONFIGURED",
        );
      }
      this.delegate = new S3ObjectStore(config);
    }
    return this.delegate;
  }

  async putObject(input: PutObjectInput): Promise<{ sizeBytes: number }> {
    return await this.getDelegate().putObject(input);
  }

  async getObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<GetObjectResult | null> {
    return await this.getDelegate().getObject(key, options);
  }

  async getPresignedGetUrl(
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null> {
    return await this.getDelegate().getPresignedGetUrl(key, expiresInSeconds);
  }

  async getPresignedPutUrl(
    key: string,
    expiresInSeconds: number,
    contentType?: string,
  ): Promise<string | null> {
    return await this.getDelegate().getPresignedPutUrl(
      key,
      expiresInSeconds,
      contentType,
    );
  }

  async deleteObject(key: string): Promise<void> {
    return this.getDelegate().deleteObject(key);
  }

  async deletePrefix(prefix: string): Promise<{ deletedCount: number }> {
    return await this.getDelegate().deletePrefix(prefix);
  }
}

// eslint-disable-next-line local/no-unknown-parameter-type
const isNotFound = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || statusCode === 404;
};
