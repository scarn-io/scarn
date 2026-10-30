import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { artifact } from "../src/definitions/artifacts";
import {
  assertValidDefinitionSpecs,
  validateDefinitionSpecs,
} from "../src/definitions/validation";
import { stepSpec } from "./definition-spec-fixtures";

const artifactInArray = (key: string) =>
  stepSpec(key, z.object({ shots: z.array(artifact({ accept: [".png"] })) }));

describe("validateDefinitionSpecs", () => {
  test.concurrent("returns no issues for a clean batch", () => {
    expect(
      validateDefinitionSpecs([stepSpec("a", z.object({ x: z.string() }))]),
    ).toEqual([]);
  });

  test.concurrent("rejects an artifact field inside an array", () => {
    const issues = validateDefinitionSpecs([artifactInArray("a")]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.check).toBe("artifact-field");
  });
});

describe("assertValidDefinitionSpecs", () => {
  test.concurrent("does nothing for a clean batch", () => {
    expect(() => {
      assertValidDefinitionSpecs([]);
    }).not.toThrow();
  });

  test.concurrent("aggregates every issue into one error", () => {
    let caught: unknown;
    try {
      assertValidDefinitionSpecs([artifactInArray("a"), artifactInArray("b")]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("Definition validation failed with 2 problems");
    expect(message).toContain('Step "a"');
    expect(message).toContain('Step "b"');
  });
});
