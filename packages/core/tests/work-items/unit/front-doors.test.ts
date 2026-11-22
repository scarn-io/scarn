import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

/**
 * Architecture test for "one front door per change"
 * (docs/plans/wayfinder.md, part 4): every write that creates or changes a
 * work item, and every block added or removed, goes through one use case
 * that runs the side effects for that change. This scans `src/` for direct
 * repo calls and fails when a file outside the allowlist makes one.
 *
 * To add a caller, route it through the front door instead. Widening an
 * allowlist means a second door to the same change.
 */

const SRC_DIR = path.join(import.meta.dir, "../../../src");

type FrontDoorRule = {
  name: string;
  pattern: RegExp;
  allowedFiles: string[];
};

const RULES: FrontDoorRule[] = [
  {
    name: "workItemRepo.create* / save*",
    pattern: /\bworkItemRepo\s*\.\s*(create\w*|save\w*)\s*\(/g,
    allowedFiles: [
      "work-items/work-item/application/create-work-item.ts",
      "work-items/work-item/application/upsert-work-item.ts",
      // Field edits. `save` can't change an existing item's state (it's left
      // out of the upsert's update clause), so these can't close or reopen.
      "work-items/work-item/application/edit-work-item.ts",
      "work-items/work-item/application/describe-work-item-by-task.ts",
      "work-items/work-item/application/label-work-item.ts",
      "work-items/work-item/application/set-work-item-parent.ts",
      "integrations/github-ingest/application/ingest-github-issue-relationships.ts",
    ],
  },
  {
    name: "workItemRepo.setState*",
    pattern: /\bworkItemRepo\s*\.\s*setState\w*\s*\(/g,
    allowedFiles: ["work-items/work-item/application/set-work-item-state.ts"],
  },
  {
    name: "workItemBlockRepo.create / delete",
    pattern: /\bworkItemBlockRepo\s*\.\s*(create|delete)\s*\(/g,
    allowedFiles: [
      "work-items/work-item-block/application/create-work-item-block.ts",
      "work-items/work-item-block/application/delete-work-item-block.ts",
    ],
  },
];

const isRepoImplementation = (relativePath: string): boolean =>
  relativePath.split("/").includes("infra");

const sourceFiles = [...new Glob("**/*.ts").scanSync({ cwd: SRC_DIR })]
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => !isRepoImplementation(file))
  .sort()
  .map((file) => ({
    file,
    contents: readFileSync(path.join(SRC_DIR, file), "utf8"),
  }));

const callersOf = (rule: FrontDoorRule): string[] =>
  sourceFiles
    .filter(({ contents }) => [...contents.matchAll(rule.pattern)].length > 0)
    .map(({ file }) => file);

describe("work item front doors", () => {
  test("scans the core source tree", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  for (const rule of RULES) {
    test(`only front-door files call ${rule.name}`, () => {
      const offenders = callersOf(rule).filter(
        (file) => !rule.allowedFiles.includes(file),
      );

      expect(offenders).toEqual([]);
    });

    test(`every allowlisted file still calls ${rule.name}`, () => {
      const callers = new Set(callersOf(rule));
      const stale = rule.allowedFiles.filter((file) => !callers.has(file));

      expect(stale).toEqual([]);
    });
  }
});
