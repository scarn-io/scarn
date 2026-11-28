import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import {
  parseS3ContentRange,
  S3ObjectStore,
} from "@/artifacts/infra/s3-object-store";
import { parseRangeHeader } from "@/artifacts/range-header";

const CONFIG = {
  bucket: "scarn-test",
  region: "us-east-1",
  endpoint: undefined,
  accessKeyId: "key",
  secretAccessKey: "secret",
  forcePathStyle: true,
};

const readText = async (
  result: { body: ReadableStream<Uint8Array> } | null,
): Promise<string | null> =>
  result ? await new Response(result.body).text() : null;

const bodyOf = (bytes: Uint8Array) => ({
  transformToWebStream: () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  transformToByteArray: () => Promise.resolve(bytes),
});

/** A stub S3 `GetObject` that honours `Range` the way S3 does. */
const stubS3 = (
  objects: Record<string, { body: Uint8Array; encoding?: "gzip" }>,
) => {
  const ranges: (string | undefined)[] = [];
  const send = (
    command: GetObjectCommand,
  ): Promise<Partial<GetObjectCommandOutput>> => {
    if (!(command instanceof GetObjectCommand)) {
      return Promise.reject(new Error("unexpected command"));
    }
    ranges.push(command.input.Range);
    const object = objects[command.input.Key ?? ""];
    if (!object) {
      return Promise.reject(
        Object.assign(new Error("missing"), { name: "NoSuchKey" }),
      );
    }
    const total = object.body.byteLength;
    const match = /^bytes=(\d+)-(\d*)$/.exec(command.input.Range ?? "");
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : total - 1;
    const slice = object.body.slice(start, end + 1);
    return Promise.resolve({
      Body: bodyOf(slice) as unknown as GetObjectCommandOutput["Body"],
      ContentType: "text/plain",
      ContentLength: slice.byteLength,
      ...(object.encoding ? { ContentEncoding: object.encoding } : {}),
      ...(match
        ? {
            ContentRange: `bytes ${String(start)}-${String(end)}/${String(total)}`,
          }
        : {}),
    });
  };
  return { client: { send } as unknown as S3Client, ranges };
};

describe("parseRangeHeader", () => {
  test("parses single byte ranges", () => {
    expect(parseRangeHeader("bytes=100-199", 1000)).toEqual({
      start: 100,
      end: 199,
    });
    expect(parseRangeHeader("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader("bytes=-500", 1000)).toEqual({
      start: 500,
      end: 999,
    });
  });

  test("clamps to the object", () => {
    expect(parseRangeHeader("bytes=900-5000", 1000)).toEqual({
      start: 900,
      end: 999,
    });
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({
      start: 0,
      end: 999,
    });
  });

  test("a range starting past the end is unsatisfiable (416)", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=2000-3000", 1000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=0-", 0)).toBe("unsatisfiable");
  });

  test("ignores absent, malformed and multi-range headers (full 200)", () => {
    expect(parseRangeHeader(null, 1000)).toBeNull();
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader("bytes=0-10,20-30", 1000)).toBeNull();
    expect(parseRangeHeader("items=0-10", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=-", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=20-10", 1000)).toBeNull();
    expect(parseRangeHeader("bytes=abc", 1000)).toBeNull();
  });
});

describe("InMemoryObjectStore.getObjectStream", () => {
  test("streams a whole object or a slice of it", async () => {
    const store = new InMemoryObjectStore();
    await store.putObject({
      key: "k",
      body: "0123456789",
      contentType: "text/plain",
    });

    const whole = await store.getObjectStream("k");
    expect(whole?.sizeBytes).toBe(10);
    expect(whole?.contentRange).toBeNull();
    expect(whole?.contentType).toBe("text/plain");
    expect(await readText(whole)).toBe("0123456789");

    const ranged = await store.getObjectStream("k", {
      range: { start: 2, end: 4 },
    });
    expect(ranged?.contentRange).toEqual({ start: 2, end: 4, total: 10 });
    expect(ranged?.sizeBytes).toBe(10);
    expect(await readText(ranged)).toBe("234");

    const open = await store.getObjectStream("k", { range: { start: 7 } });
    expect(open?.contentRange).toEqual({ start: 7, end: 9, total: 10 });
    expect(await readText(open)).toBe("789");
  });

  test("returns null for a missing key", async () => {
    expect(
      await new InMemoryObjectStore().getObjectStream("missing"),
    ).toBeNull();
  });

  test("ignores the range for a gzip-encoded object", async () => {
    const store = new InMemoryObjectStore();
    await store.putObject({ key: "log", body: "abcdef", compress: true });

    const result = await store.getObjectStream("log", {
      range: { start: 1, end: 2 },
    });
    expect(result?.contentRange).toBeNull();
    expect(result?.sizeBytes).toBe(6);
    expect(await readText(result)).toBe("abcdef");
  });

  test("rejects when the signal is already aborted", async () => {
    const store = new InMemoryObjectStore();
    await store.putObject({ key: "k", body: "x" });
    const outcome = await store
      .getObjectStream("k", { signal: AbortSignal.abort() })
      .then(
        () => "resolved",
        () => "rejected",
      );
    expect(outcome).toBe("rejected");
  });
});

describe("S3ObjectStore.getObjectStream", () => {
  const raw = new TextEncoder().encode("0123456789");

  test("sends a Range header and reports the content range", async () => {
    const { client, ranges } = stubS3({ k: { body: raw } });
    const store = new S3ObjectStore(CONFIG, client);

    const ranged = await store.getObjectStream("k", {
      range: { start: 3, end: 5 },
    });
    expect(ranges).toEqual(["bytes=3-5"]);
    expect(ranged?.contentRange).toEqual({ start: 3, end: 5, total: 10 });
    expect(ranged?.sizeBytes).toBe(10);
    expect(await readText(ranged)).toBe("345");

    const open = await store.getObjectStream("k", { range: { start: 8 } });
    expect(ranges.at(-1)).toBe("bytes=8-");
    expect(await readText(open)).toBe("89");
  });

  test("streams the whole object without a range", async () => {
    const { client, ranges } = stubS3({ k: { body: raw } });
    const store = new S3ObjectStore(CONFIG, client);

    const whole = await store.getObjectStream("k");
    expect(ranges).toEqual([undefined]);
    expect(whole?.contentRange).toBeNull();
    expect(whole?.sizeBytes).toBe(10);
    expect(whole?.contentType).toBe("text/plain");
    expect(await readText(whole)).toBe("0123456789");
  });

  test("returns null for a missing key", async () => {
    const { client } = stubS3({});
    expect(
      await new S3ObjectStore(CONFIG, client).getObjectStream("nope"),
    ).toBeNull();
  });

  test("serves a gzip-encoded object whole and decompressed", async () => {
    const { client } = stubS3({
      log: { body: gzipSync(raw), encoding: "gzip" },
    });
    const store = new S3ObjectStore(CONFIG, client);

    const ranged = await store.getObjectStream("log", {
      range: { start: 1, end: 2 },
    });
    expect(ranged?.contentRange).toBeNull();
    expect(ranged?.sizeBytes).toBe(10);
    expect(await readText(ranged)).toBe("0123456789");

    const whole = await store.getObjectStream("log");
    expect(await readText(whole)).toBe("0123456789");
  });

  test("parses S3 Content-Range values", () => {
    expect(parseS3ContentRange("bytes 0-9/10")).toEqual({
      start: 0,
      end: 9,
      total: 10,
    });
    expect(parseS3ContentRange(undefined)).toBeNull();
    expect(parseS3ContentRange("bytes */10")).toBeNull();
  });
});
