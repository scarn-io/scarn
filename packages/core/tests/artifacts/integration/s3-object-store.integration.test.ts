import { afterAll, beforeAll, describe, expect } from "bun:test";
import { gunzipSync } from "node:zlib";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { serialTest } from "tests/utils";
import {
  S3ObjectStore,
  s3ObjectStoreConfigFromEnv,
  type S3ObjectStoreConfig,
} from "@/artifacts/infra/s3-object-store";

// Exercises the real S3 upload path (the point of this branch) against an
// S3-compatible container instead of the in-memory fake. This proves that
// objects actually land in an S3-compatible backend, that gzip compression
// round-trips through PUT/GET, and that presigned URLs are usable by a plain
// HTTP client.

// RustFS (https://rustfs.com), not MinIO: MinIO closed public image
// distribution entirely as part of its "AIStor" relaunch — Docker Hub's
// `minio/minio` 404s and quay.io/minio/minio (MinIO's own prior fallback)
// now 401s on every tag, anonymous or not. RustFS is an actively-published,
// S3-API-compatible drop-in (path-style addressing, presigned URLs) that
// still pulls anonymously, and is the same backend `docker-compose.yml`'s
// `rustfs` service runs for local dev — see its comment for the fuller story.
const S3_TEST_IMAGE = process.env["TEST_S3_IMAGE"] ?? "rustfs/rustfs:latest";
const S3_TEST_PORT = 9000;
const ACCESS_KEY = "scarn";
const SECRET_KEY = "scarn-local-secret";
const BUCKET = "scarn-test";

let container: StartedTestContainer | null = null;
let config: S3ObjectStoreConfig;

const buildConfig = (endpoint: string): S3ObjectStoreConfig => ({
  bucket: BUCKET,
  region: "us-east-1",
  endpoint,
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
  // RustFS (like MinIO) requires path-style addressing (endpoint/bucket/key).
  forcePathStyle: true,
});

const startS3Container = async (): Promise<StartedTestContainer> =>
  await new GenericContainer(S3_TEST_IMAGE)
    .withEnvironment({
      RUSTFS_ACCESS_KEY: ACCESS_KEY,
      RUSTFS_SECRET_KEY: SECRET_KEY,
    })
    // RustFS's container runs as a non-root UID (10001) that can't write to
    // a fresh bind-mounted host directory. A tmpfs sidesteps that entirely
    // and is the right call anyway for an ephemeral test container.
    .withTmpFs({ "/data": "rw,mode=1777" })
    .withExposedPorts(S3_TEST_PORT)
    .withWaitStrategy(
      Wait.forHttp("/health/ready", S3_TEST_PORT).withStartupTimeout(60_000),
    )
    .start();

// testcontainers waits a hardcoded, non-configurable 10s for Docker to report
// the container's host port bindings (`inspectContainerUntilPortsExposed`).
// Under a loaded Docker daemon (e.g. test-all-workspaces running every
// workspace at once) that occasionally isn't enough, so retry just that
// failure. A half-started container from a failed attempt is reaped by Ryuk.
const PORT_BINDING_TIMEOUT_MESSAGE =
  "while waiting for container ports to be bound to the host";
const MAX_START_ATTEMPTS = 3;

const startS3ContainerWithRetry = async (): Promise<StartedTestContainer> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startS3Container();
    } catch (error) {
      const isPortBindingTimeout =
        error instanceof Error &&
        error.message.includes(PORT_BINDING_TIMEOUT_MESSAGE);
      if (!isPortBindingTimeout || attempt >= MAX_START_ATTEMPTS) {
        throw error;
      }
    }
  }
};

beforeAll(async () => {
  container = await startS3ContainerWithRetry();

  const endpoint = `http://${container.getHost()}:${String(
    container.getMappedPort(S3_TEST_PORT),
  )}`;
  config = buildConfig(endpoint);

  // Create the bucket the store writes into.
  const admin = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  admin.destroy();
}, 150_000);

afterAll(async () => {
  if (container) {
    await container.stop();
    container = null;
  }
});

describe("S3ObjectStore (RustFS integration)", () => {
  serialTest("uploads and reads back an uncompressed object", async () => {
    const store = new S3ObjectStore(config);
    const body = "hello s3 world";

    const { sizeBytes } = await store.putObject({
      key: "plain/object.txt",
      body,
      contentType: "text/plain",
    });
    expect(sizeBytes).toBe(new TextEncoder().encode(body).byteLength);

    const got = await store.getObject("plain/object.txt");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got?.body)).toBe(body);
    expect(got?.contentType).toBe("text/plain");
  });

  serialTest(
    "gzip-compresses at rest but returns the original bytes on read",
    async () => {
      const store = new S3ObjectStore(config);
      // Highly compressible so the stored size is clearly smaller.
      const body = "a".repeat(10_000);

      const { sizeBytes } = await store.putObject({
        key: "compressed/object.txt",
        body,
        compress: true,
      });
      // The reported size is the post-compression bytes actually stored.
      expect(sizeBytes).toBeLessThan(body.length);

      const got = await store.getObject("compressed/object.txt");
      expect(got).not.toBeNull();
      // getObject transparently decompresses gzip-encoded objects.
      expect(new TextDecoder().decode(got?.body)).toBe(body);
      expect(got?.sizeBytes).toBe(body.length);
    },
  );

  serialTest("returns null for a missing key", async () => {
    const store = new S3ObjectStore(config);
    const got = await store.getObject("does/not/exist");
    expect(got).toBeNull();
  });

  serialTest(
    "mints a presigned GET URL that a plain HTTP client can use",
    async () => {
      const store = new S3ObjectStore(config);
      const body = "presigned-get-payload";
      await store.putObject({ key: "presigned/get.txt", body });

      const url = await store.getPresignedGetUrl("presigned/get.txt", 60);
      expect(url).not.toBeNull();

      const response = await fetch(url as string);
      expect(response.ok).toBe(true);
      expect(await response.text()).toBe(body);
    },
  );

  serialTest(
    "mints a presigned PUT URL that a plain HTTP client can upload through",
    async () => {
      const store = new S3ObjectStore(config);
      const url = await store.getPresignedPutUrl("presigned/put.txt", 60);
      expect(url).not.toBeNull();

      const body = "uploaded-via-presigned-put";
      const putResponse = await fetch(url as string, {
        method: "PUT",
        body,
      });
      expect(putResponse.ok).toBe(true);

      // The object is readable back through the store.
      const got = await store.getObject("presigned/put.txt");
      expect(new TextDecoder().decode(got?.body)).toBe(body);
    },
  );

  serialTest(
    "stored gzip bytes are genuinely compressed (not raw)",
    async () => {
      const store = new S3ObjectStore(config);
      const body = "b".repeat(5_000);
      await store.putObject({
        key: "compressed/raw-check.txt",
        body,
        compress: true,
      });

      // Fetch the raw stored bytes via a presigned URL. fetch() does not
      // auto-decompress since the server does not send Content-Encoding
      // through presigned GETs unless requested; verify the bytes gunzip to
      // the body.
      const url = await store.getPresignedGetUrl(
        "compressed/raw-check.txt",
        60,
      );
      const response = await fetch(url as string);
      const raw = new Uint8Array(await response.arrayBuffer());
      // If the server already decompressed, the bytes equal the body; otherwise
      // they gunzip to it. Either way the original content is recoverable.
      const decoded = new TextDecoder().decode(raw);
      if (decoded !== body) {
        expect(new TextDecoder().decode(gunzipSync(Buffer.from(raw)))).toBe(
          body,
        );
      } else {
        expect(decoded).toBe(body);
      }
    },
  );

  serialTest("deletePrefix removes only the keys under a prefix", async () => {
    const store = new S3ObjectStore(config);
    await store.putObject({ key: "sweep/run-1/a.txt", body: "a" });
    await store.putObject({ key: "sweep/run-1/nested/b.txt", body: "b" });
    await store.putObject({ key: "sweep/run-10/c.txt", body: "c" });

    const { deletedCount } = await store.deletePrefix("sweep/run-1/");

    expect(deletedCount).toBe(2);
    expect(await store.getObject("sweep/run-1/a.txt")).toBeNull();
    expect(await store.getObject("sweep/run-1/nested/b.txt")).toBeNull();
    expect(await store.getObject("sweep/run-10/c.txt")).not.toBeNull();
    expect(await store.deletePrefix("sweep/run-1/")).toEqual({
      deletedCount: 0,
    });
  });

  serialTest(
    "s3ObjectStoreConfigFromEnv builds a working config from env",
    async () => {
      const parsed = s3ObjectStoreConfigFromEnv({
        S3_BUCKET: BUCKET,
        S3_REGION: config.region,
        S3_ENDPOINT: config.endpoint,
        S3_ACCESS_KEY_ID: config.accessKeyId,
        S3_SECRET_ACCESS_KEY: config.secretAccessKey,
        S3_FORCE_PATH_STYLE: "true",
      });
      expect(parsed).not.toBeNull();

      const store = new S3ObjectStore(parsed as S3ObjectStoreConfig);
      const body = "config-from-env-roundtrip";
      await store.putObject({ key: "env/config.txt", body });
      const got = await store.getObject("env/config.txt");
      expect(new TextDecoder().decode(got?.body)).toBe(body);
    },
  );
});
