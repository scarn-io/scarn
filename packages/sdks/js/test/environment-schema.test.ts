import { describe, expect, test } from "bun:test";
import {
  environmentContentSchema,
  environmentNameSchema,
  environmentRefSchema,
  storedEnvironmentContentSchema,
} from "../src/environment";

describe("environment name schema", () => {
  test.each(["a", "0", "frontend", "node-24", "a-"])(
    "accepts environment name %s",
    (name) => {
      expect(environmentNameSchema.safeParse(name).success).toBe(true);
    },
  );
  test.each(["", "Frontend", "-frontend", "../frontend", "a/b", "a_b", "a\n"])(
    "rejects environment name %j",
    (name) => {
      expect(environmentNameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe("environment branch", () => {
  const message = "environments have no branch; use the step's repo baseBranch";

  test("named environment content rejects a branch on write", () => {
    const parsed = environmentContentSchema.safeParse({ branch: "develop" });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      message,
    ]);
  });

  test("an inline environment rejects a branch on write", () => {
    const parsed = environmentRefSchema.safeParse({
      kind: "inline",
      branch: "develop",
    });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      message,
    ]);
  });

  test("stored content with a branch still reads, without it", () => {
    expect(storedEnvironmentContentSchema.parse({ branch: "develop" })).toEqual(
      {},
    );
  });
});
