import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PIPELINE_BUILDER_DIR,
  collectDefinitionsFromDirectory,
  collectDefinitionsFromDirectoryTolerant,
} from "../src/push/collect-definitions";

function makeTempDir(): string {
  return realpathSync(
    mkdtempSync(join(tmpdir(), "scarn-collect-defs-test-")),
  );
}

// Absolute path to `define-code-step.ts`, computed from this test file's own
// location rather than `process.cwd()` (which is the SDK package root when
// running `bun test`, not necessarily a stable anchor for a fixture written
// into an arbitrary temp directory).
const CODE_STEP_MODULE_PATH = join(
  import.meta.dir,
  "../src/definitions/steps/define-code-step",
);

function codeStepImportSpecifier(fromDir: string): string {
  const rel = relative(fromDir, CODE_STEP_MODULE_PATH);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

async function collectionError(dir: string): Promise<string> {
  try {
    await collectDefinitionsFromDirectory(dir);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("collectDefinitionsFromDirectory — code steps", () => {
  test("resolves a code step's entrypoint to { sourceFile } and strips fn", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "review-file-step.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export function doReview(input) {
  return { ok: true };
}

export const reviewFileStep = codeStep({
  key: "review-file",
  name: "Review File",
  fn: doReview,
});
`,
      );

      const collected = await collectDefinitionsFromDirectory(dir);
      const step = collected.steps.find((s) => s.key === "review-file");

      expect(step).toBeDefined();
      expect(step?.kind).toBe("code");
      expect(step?.entrypoint).toBeUndefined();
      expect(step?.entrypointJson).toEqual({
        sourceFile: join(PIPELINE_BUILDER_DIR, "review-file-step.ts"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression test for the bug where `scarn pipelines push` (and
  // `studio`) spawn their collecting subprocess with `cwd` already set to
  // the pipeline-builder directory being collected — the real-world
  // condition `resolveCodeStepEntrypoint` must resolve `sourceFile`
  // correctly under, since `process.cwd()` can no longer be trusted as a
  // repo-root anchor there. See collect-definitions.ts's own doc comment.
  test("resolves sourceFile correctly even when process.cwd() is the collected directory itself", async () => {
    const dir = makeTempDir();
    const originalCwd = process.cwd();
    try {
      writeFileSync(
        join(dir, "review-file-step.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export function doReview(input) {
  return { ok: true };
}

export const reviewFileStep = codeStep({
  key: "review-file",
  name: "Review File",
  fn: doReview,
});
`,
      );

      process.chdir(dir);
      const collected = await collectDefinitionsFromDirectory(dir);
      const step = collected.steps.find((s) => s.key === "review-file");

      expect(step?.entrypointJson?.sourceFile).toBe(
        join(PIPELINE_BUILDER_DIR, "review-file-step.ts"),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts an inline arrow as fn", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "inline-step.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export const inlineStep = codeStep({
  key: "inline-step",
  name: "Inline Step",
  fn: (input) => input,
});
`,
      );

      const collected = await collectDefinitionsFromDirectory(dir);
      const step = collected.steps.find((s) => s.key === "inline-step");

      expect(step?.entrypoint).toBeUndefined();
      expect(step?.entrypointJson).toEqual({
        sourceFile: join(PIPELINE_BUILDER_DIR, "inline-step.ts"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when two code steps share a key with different versions", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "versions.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export const stepV1 = codeStep({ key: "shared", name: "Shared", version: 1, fn: () => 1 });
export const stepV2 = codeStep({ key: "shared", name: "Shared", version: 2, fn: () => 2 });
`,
      );

      expect(await collectionError(dir)).toMatch(
        /"shared" is defined with different versions/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when two files define the same key with different fn references", async () => {
    const dir = makeTempDir();
    try {
      for (const file of ["a.ts", "b.ts"]) {
        writeFileSync(
          join(dir, file),
          `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export const step = codeStep({ key: "shared", name: "Shared", fn: () => "${file}" });
`,
        );
      }

      expect(await collectionError(dir)).toMatch(
        /"shared" is defined with different fn references/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not throw when two files share a key through the same fn", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "original.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export const step = codeStep({ key: "shared", name: "Shared", fn: () => 1 });
`,
      );
      writeFileSync(
        join(dir, "reexport.ts"),
        `export { step } from "./original";\n`,
      );

      const collected = await collectDefinitionsFromDirectory(dir);

      expect(collected.steps.filter((s) => s.key === "shared")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectDefinitionsFromDirectoryTolerant", () => {
  test("isolates one broken file — every other file's steps still collect", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        join(dir, "good-step.ts"),
        `
import { codeStep } from "${codeStepImportSpecifier(dir)}";

export const goodStep = codeStep({ key: "good-step", name: "Good", fn: () => 1 });
`,
      );
      writeFileSync(
        join(dir, "bad-pipeline.ts"),
        `throw new Error('state "a" targets unknown state "b"');\n`,
      );

      const collected = await collectDefinitionsFromDirectoryTolerant(dir);

      expect(collected.steps.map((s) => s.key)).toEqual(["good-step"]);
      expect(collected.brokenPipelines).toHaveLength(1);
      expect(collected.brokenPipelines[0]).toMatchObject({
        key: "bad-pipeline",
        message: 'state "a" targets unknown state "b"',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty directory collects cleanly with no broken pipelines", async () => {
    const dir = makeTempDir();
    try {
      const collected = await collectDefinitionsFromDirectoryTolerant(dir);
      expect(collected).toMatchObject({
        steps: [],
        brokenPipelines: [],
        defaultPipelineAssignment: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
