import { describe, expect, test } from "bun:test";
import { version } from "../package.json";
import {
  CONTROL_API_PROTOCOL,
  resolveWorkerVersion,
} from "../src/lib/worker-version";

describe("resolveWorkerVersion", () => {
  test("is the package version when running from source", () => {
    expect(resolveWorkerVersion()).toBe(version);
  });

  test("appends a dev build's ID", () => {
    expect(resolveWorkerVersion({ version: "1.2.3", buildId: "abc" })).toBe(
      "1.2.3+dev.abc",
    );
  });

  test("is the bare version without a build ID", () => {
    expect(resolveWorkerVersion({ version: "1.2.3", buildId: undefined })).toBe(
      "1.2.3",
    );
  });

  test("re-exports the control API protocol", () => {
    expect(Number.isInteger(CONTROL_API_PROTOCOL)).toBe(true);
  });
});
