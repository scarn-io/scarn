import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { taskLifecycleRule } from "@scarn/core/billing/usage-meter/domain/storage-retention";

const lifecyclePath = resolve(
  import.meta.dir,
  "../../../docker/selfhost/lifecycle.json",
);

describe("docker/selfhost/lifecycle.json", () => {
  test("matches the retention rules in @scarn/core", () => {
    expect(JSON.parse(readFileSync(lifecyclePath, "utf-8"))).toEqual(
      taskLifecycleRule(),
    );
  });
});
