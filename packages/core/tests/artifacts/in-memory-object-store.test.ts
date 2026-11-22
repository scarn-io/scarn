import { describe, expect } from "bun:test";
import { gunzipSync } from "node:zlib";
import { concurrentTest } from "tests/utils";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";

describe("InMemoryObjectStore compression", () => {
  concurrentTest(
    "stores compressed bytes but returns the original body on read",
    async () => {
      const store = new InMemoryObjectStore();
      // Highly compressible payload so the stored size is clearly smaller.
      const body = "a".repeat(10_000);

      const { sizeBytes } = await store.putObject({
        key: "k",
        body,
        compress: true,
      });

      // putObject reports the post-compression size (what lands at rest).
      expect(sizeBytes).toBeLessThan(body.length);

      const got = await store.getObject("k");
      expect(got).not.toBeNull();
      // Callers always see the original decompressed bytes.
      expect(new TextDecoder().decode(got?.body)).toBe(body);
      expect(got?.sizeBytes).toBe(body.length);
    },
  );

  concurrentTest("stores raw bytes when compression is disabled", async () => {
    const store = new InMemoryObjectStore();
    const body = "hello";

    const { sizeBytes } = await store.putObject({ key: "k", body });

    expect(sizeBytes).toBe(body.length);
    const got = await store.getObject("k");
    expect(new TextDecoder().decode(got?.body)).toBe(body);
    // Not gzip — decompressing arbitrary stored bytes would fail.
    expect(() =>
      gunzipSync(Buffer.from(got?.body ?? new Uint8Array())),
    ).toThrow();
  });
});

describe("InMemoryObjectStore deletePrefix", () => {
  concurrentTest("deletes only the keys under the prefix", async () => {
    const store = new InMemoryObjectStore();
    await store.putObject({ key: "tasks/run-1/session.json", body: "a" });
    await store.putObject({ key: "tasks/run-1/nested/x", body: "b" });
    await store.putObject({ key: "tasks/run-10/session.json", body: "c" });

    const { deletedCount } = await store.deletePrefix("tasks/run-1/");

    expect(deletedCount).toBe(2);
    expect(await store.getObject("tasks/run-1/session.json")).toBeNull();
    expect(await store.getObject("tasks/run-1/nested/x")).toBeNull();
    expect(await store.getObject("tasks/run-10/session.json")).not.toBeNull();
  });

  concurrentTest("is a no-op for an empty prefix range", async () => {
    const store = new InMemoryObjectStore();
    expect(await store.deletePrefix("tasks/missing/")).toEqual({
      deletedCount: 0,
    });
  });
});
