import { describe, expect, test } from "bun:test";
import { formatValidationError, validatePipeline } from "../../src/pipelines";
import { bugPipeline, bugSteps, fullSpecBugPipeline } from "./fixtures";
import { itemsPipeline, itemSteps } from "./fixtures-items";

describe("example pipelines", () => {
  test.concurrent("the bug pipeline (v1 version) is valid", () => {
    const result = validatePipeline(bugPipeline(), bugSteps);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document?.key).toBe("bug-pipeline");
  });

  test.concurrent("the items pipeline is valid", () => {
    expect(validatePipeline(itemsPipeline(), itemSteps)).toMatchObject({
      ok: true,
      errors: [],
    });
  });

  test.concurrent(
    "the spec's full bug pipeline is rejected only for its not-in-v1 features",
    () => {
      const result = validatePipeline(fullSpecBugPipeline(), bugSteps);
      expect(result.ok).toBe(false);
      expect(result.errors.every((error) => error.code === "not_in_v1")).toBe(
        true,
      );
      expect(result.errors.map((error) => [error.path, error.message])).toEqual(
        [
          [
            "/timeoutSeconds",
            "A pipeline-level timeoutSeconds is not supported in v1",
          ],
          [
            "/nodes/approve-fix/timeoutSeconds",
            "timeoutSeconds on a wait node is not supported in v1",
          ],
          [
            "/nodes/fix/retry/0/intervalSeconds",
            'Retry "intervalSeconds" is not supported in v1',
          ],
          [
            "/nodes/fix/retry/0/backoffRate",
            'Retry "backoffRate" is not supported in v1',
          ],
        ],
      );
    },
  );

  test.concurrent("formatValidationError prints path, message and hint", () => {
    expect(
      formatValidationError({
        path: "/nodes/fix/next/otherwise/args/plan",
        message: "missing",
        hint: 'Did you mean "input.plan"?',
      }),
    ).toBe(
      '/nodes/fix/next/otherwise/args/plan: missing. Did you mean "input.plan"?',
    );
    expect(formatValidationError({ path: "", message: "bad" })).toBe("/: bad");
  });

  test.concurrent(
    "validation is pure: the input document is not modified",
    () => {
      const document = bugPipeline();
      const before = JSON.stringify(document);
      validatePipeline(document, bugSteps);
      expect(JSON.stringify(document)).toBe(before);
    },
  );
});
