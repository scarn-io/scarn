import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";
import {
  deriveArtifactObjectKey,
  normalizeRelativeStorePath,
} from "@/tasks/task-artifact/domain/artifact-object-key";

describe("normalizeRelativeStorePath", () => {
  concurrentTest("collapses leading './' and redundant slashes", () => {
    expect(normalizeRelativeStorePath("./reports//out.txt")).toBe(
      "reports/out.txt",
    );
    expect(normalizeRelativeStorePath("  a/b/c.json  ")).toBe("a/b/c.json");
  });

  concurrentTest("rejects empty or whitespace-only paths", () => {
    for (const bad of ["", "   ", "./", "."]) {
      try {
        normalizeRelativeStorePath(bad);
        throw new Error(`expected '${bad}' to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(CoreValidationError);
        expect((error as CoreValidationError).code).toBe(
          "INVALID_ARTIFACT_PATH",
        );
      }
    }
  });

  concurrentTest("rejects absolute paths", () => {
    expect(() => normalizeRelativeStorePath("/etc/passwd")).toThrow(
      CoreValidationError,
    );
  });

  concurrentTest("rejects backslashes", () => {
    expect(() => normalizeRelativeStorePath("reports\\out.txt")).toThrow(
      CoreValidationError,
    );
  });

  concurrentTest("rejects '..' traversal segments", () => {
    for (const bad of ["../secret", "reports/../../etc", "a/../b"]) {
      try {
        normalizeRelativeStorePath(bad);
        throw new Error(`expected '${bad}' to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(CoreValidationError);
        expect((error as CoreValidationError).code).toBe(
          "INVALID_ARTIFACT_PATH",
        );
      }
    }
  });
});

describe("deriveArtifactObjectKey", () => {
  concurrentTest(
    "produces artifacts/<projectId>/<taskRunId>/<normalized>",
    () => {
      const projectId = createUuidV7();
      const taskRunId = createUuidV7();

      const key = deriveArtifactObjectKey({
        projectId,
        taskRunId: taskRunId,
        relativeStorePath: "./reports//summary.json",
      });

      expect(key).toBe(
        `artifacts/${projectId}/${taskRunId}/reports/summary.json`,
      );
    },
  );

  concurrentTest("propagates path validation failures", () => {
    const projectId = createUuidV7();
    const taskRunId = createUuidV7();

    expect(() =>
      deriveArtifactObjectKey({
        projectId,
        taskRunId: taskRunId,
        relativeStorePath: "../escape",
      }),
    ).toThrow(CoreValidationError);
  });
});
