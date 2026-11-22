import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Every non-test source file that builds an `AppContext` (`createAppContext(`)
 * or uses the prebuilt `DefaultAppContext` is an entry point whose
 * `workNotifier.enqueued` calls need a `runWithWorkNotifyScope` around them,
 * or they are dropped and workers wait for their next poll. Each such file
 * must either open that scope itself or be listed below with a reason, so a
 * new entry point fails here until someone decides.
 */
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const WRAPPED = [
  "apps/api/src/app.ts",
  "apps/api-cloudflare/src/index.ts",
  "apps/api-lambda/src/index.ts",
];

const ALLOWLIST: Record<string, string> = {
  "packages/core/src/lib/di.ts":
    "Defines createAppContext and DefaultAppContext; callers own the scope.",
  "apps/api/src/seed-demo-project.ts":
    "Seeds the public demo project, whose runs the seed drives itself; no worker serves it, so there is no one to wake.",
  "packages/local-dev/src/seed.ts":
    "Only resets the project directly (deletes, queues nothing); work items are seeded over HTTP, inside the API's request scope.",
};

const SOURCE_GLOB = new Bun.Glob("{apps,packages}/*/{src,app}/**/*.{ts,tsx}");
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".next",
  "test",
  "tests",
]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const BUILDS_APP_CONTEXT = /\bcreateAppContext\(|\bDefaultAppContext\b/;
const OPENS_NOTIFY_SCOPE = /\brunWithWorkNotifyScope\(/;

const existsInRepo = (relativePath: string) =>
  existsSync(path.join(REPO_ROOT, relativePath));

const stripComments = (source: string) =>
  source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");

const isSourceFile = (relativePath: string) =>
  !TEST_FILE.test(relativePath) &&
  !relativePath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));

const scanEntryPoints = async () => {
  const entryPoints = new Map<string, string>();
  for await (const relativePath of SOURCE_GLOB.scan({ cwd: REPO_ROOT })) {
    if (!isSourceFile(relativePath)) {
      continue;
    }
    const code = stripComments(
      await Bun.file(path.join(REPO_ROOT, relativePath)).text(),
    );
    if (BUILDS_APP_CONTEXT.test(code)) {
      entryPoints.set(relativePath, code);
    }
  }
  return entryPoints;
};

describe("AppContext entry points", () => {
  test("each one opens a work-notify scope or is allowlisted with a reason", async () => {
    const entryPoints = await scanEntryPoints();

    // The public mirror leaves out some apps, so only expect files that exist.
    const wrapped = WRAPPED.filter(existsInRepo);
    expect([...entryPoints.keys()].sort()).toEqual(
      [...wrapped, ...Object.keys(ALLOWLIST).filter(existsInRepo)].sort(),
    );
    for (const file of wrapped) {
      expect({
        file,
        wrapped: OPENS_NOTIFY_SCOPE.test(entryPoints.get(file) ?? ""),
      }).toEqual({
        file,
        wrapped: true,
      });
    }
  });
});
