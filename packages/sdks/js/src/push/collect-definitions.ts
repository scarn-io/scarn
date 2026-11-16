// The offline half of `pushFromDirectory`: turn a directory of definition files
// into the specs they export.
//
// Deliberately takes no token and makes no network call, so the same collection
// a real push performs can be exercised — and validated — with no server. The
// upsert half lives in `push-from-directory.ts`.

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type {
  EnvironmentContent,
  EnvironmentHandle,
} from "../definitions/environments/define-environment";
import type { StepDefinitionSpec } from "../definitions/steps";
import {
  stepEnvironmentHandle,
  toStepSpec,
} from "../definitions/steps/step-handle";
import {
  isEnvironmentHandle,
  isStepDefinitionSpec,
  stepsInModule,
} from "./code-step-lookup";

/**
 * Files that drive a push or the pipeline-builder studio rather than
 * declaring definitions themselves.
 */
const INTERNAL_SCRIPT_NAMES = new Set([
  "push.ts",
  "push.mjs",
  "push.js",
  ".scarn-studio-collect.mjs",
  ".scarn-build.ts",
]);

/**
 * The fixed, repo-root-relative directory `scarn pipelines init` scaffolds
 * and `scarn pipelines push`/`studio` always run from. `resolveCodeStepEntrypoint`
 * uses this to record a `kind: "code"` step's `sourceFile` relative to the repo
 * root (what the worker's `execute-code-step.ts` expects when it joins
 * `sourceFile` onto the checked-out workspace root), regardless of what the
 * collecting process's own `cwd` happens to be.
 *
 * Duplicated nowhere else — `@scarn/worker`'s own `PIPELINE_BUILDER_DIR`
 * imports this one, so there's a single source of truth.
 */
export const PIPELINE_BUILDER_DIR = ".scarn/pipeline-builder";

/** A named environment found while collecting, and the file it came from. */
export type CollectedEnvironment = {
  readonly name: string;
  readonly content: EnvironmentContent;
  /** The builder file's basename, e.g. `environments.ts`. */
  readonly sourceFile: string;
};

export type CollectedDefinitions = {
  /** Deduped by `key@vN`. */
  readonly steps: readonly StepDefinitionSpec[];
  /**
   * Exported `defineEnvironment` handles plus any handle a collected step
   * uses, deduped by name.
   */
  readonly environments: readonly CollectedEnvironment[];
};

/**
 * One source file that failed to import —
 * `collectDefinitionsFromDirectoryTolerant`'s per-file counterpart to a
 * `collectDefinitionsFromDirectory` throw. `key` is the file's own basename
 * (no extension).
 */
export type BrokenPipeline = {
  readonly key: string;
  readonly message: string;
};

export type TolerantCollectedDefinitions = CollectedDefinitions & {
  readonly brokenPipelines: readonly BrokenPipeline[];
};

type RegisteredCodeStep = {
  readonly version: number;
  readonly fn: unknown;
  readonly sourceFile: string;
};

/** Mutable accumulator shared by every file of one collection run. */
type CollectionState = {
  readonly stepMap: Map<string, StepDefinitionSpec>;
  readonly codeSteps: Map<string, RegisteredCodeStep>;
  readonly environments: Map<string, CollectedEnvironmentEntry>;
};

type CollectedEnvironmentEntry = {
  readonly handle: EnvironmentHandle;
  readonly sourceFile: string;
  /** False when only a step reached it; an exporting file then takes over `sourceFile`. */
  readonly exported: boolean;
};

function createCollectionState(): CollectionState {
  return { stepMap: new Map(), codeSteps: new Map(), environments: new Map() };
}

/**
 * Every environment handle a module reaches: its exported handles, then the
 * handles its exported steps were given and that it doesn't export.
 */
function environmentHandlesInModule(
  mod: Readonly<Record<string, unknown>>,
): { handle: EnvironmentHandle; exported: boolean }[] {
  const found = new Map<EnvironmentHandle, boolean>();
  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName !== "default" && isEnvironmentHandle(value)) {
      found.set(value, true);
    }
  }
  for (const step of stepsInModule(mod)) {
    const handle = stepEnvironmentHandle(step);
    if (handle && !found.has(handle)) found.set(handle, false);
  }
  return [...found].map(([handle, exported]) => ({ handle, exported }));
}

/**
 * The environment entries one file adds or updates. Throws when a name is
 * already taken by different content; the same handle, or another handle
 * with equal content, seen again is fine. Reads `state` without changing it,
 * so a conflict rejects the whole file.
 */
function environmentEntriesForFile(
  state: CollectionState,
  found: readonly { handle: EnvironmentHandle; exported: boolean }[],
  sourceFile: string,
): CollectedEnvironmentEntry[] {
  const entries = new Map<string, CollectedEnvironmentEntry>();
  for (const { handle, exported } of found) {
    const existing =
      entries.get(handle.name) ?? state.environments.get(handle.name);
    if (existing === undefined) {
      entries.set(handle.name, { handle, sourceFile, exported });
      continue;
    }
    if (
      existing.handle !== handle &&
      !isDeepStrictEqual(existing.handle.content, handle.content)
    ) {
      throw new Error(
        `Environment "${handle.name}" is defined twice with different content ` +
          `(${existing.sourceFile} and ${sourceFile}). ` +
          `Give each environment a unique name, or define it once and import it.`,
      );
    }
    if (exported && !existing.exported) {
      entries.set(handle.name, { handle, sourceFile, exported });
    }
  }
  return [...entries.values()];
}

/**
 * Records a code step under its `key` and throws when the key is already
 * taken by a step with a different version or a different `fn` — the worker
 * finds a code step by `key` alone, so a shared key must mean one function.
 */
function registerCodeStep(
  state: CollectionState,
  spec: StepDefinitionSpec,
  sourceFile: string,
): void {
  const fn = spec.entrypoint?.fn;
  if (spec.kind !== "code" || !fn) return;

  const existing = state.codeSteps.get(spec.key);
  if (!existing) {
    state.codeSteps.set(spec.key, { version: spec.version, fn, sourceFile });
    return;
  }
  if (existing.version !== spec.version) {
    throw new Error(
      `Code step "${spec.key}" is defined with different versions ` +
        `(v${String(existing.version)} in ${existing.sourceFile}, v${String(spec.version)} in ${sourceFile}). ` +
        `A code step is found by key alone, so give each code step a unique key.`,
    );
  }
  if (existing.fn !== fn) {
    throw new Error(
      `Code step "${spec.key}" is defined with different fn references ` +
        `(${existing.sourceFile} and ${sourceFile}). ` +
        `A code step is found by key alone, so give each code step a unique key.`,
    );
  }
}

/**
 * For a `kind === "code"` spec: records `sourceFile` — the file that defines
 * the step, relative to the repo root as `PIPELINE_BUILDER_DIR/<file>`, since
 * `absDir` (the directory being collected) is always `PIPELINE_BUILDER_DIR`
 * itself — as `entrypointJson`, and strips the live `fn` reference (it can
 * never be serialized into the push request). Every kind comes back as a
 * plain spec (`toStepSpec`), never as the callable handle, so the result
 * survives `JSON.stringify`.
 *
 * Deliberately does *not* use `process.cwd()`: `scarn pipelines push` and
 * `studio` both spawn their collecting subprocess with `cwd` already set to
 * `PIPELINE_BUILDER_DIR` (so the subprocess's own runtime/lockfile detection
 * resolves correctly), which previously made `relative(process.cwd(), ...)`
 * collapse to a bare filename with no `PIPELINE_BUILDER_DIR` prefix — the
 * worker then joined that bare filename onto the workspace root and looked
 * in the wrong place (`ERR_MODULE_NOT_FOUND`). Anchoring on `absDir` instead
 * is correct regardless of the calling process's cwd.
 */
function resolveCodeStepEntrypoint(
  spec: StepDefinitionSpec,
  absoluteFilePath: string,
  absDir: string,
): StepDefinitionSpec {
  if (spec.kind !== "code") return toStepSpec(spec);

  if (!spec.entrypoint?.fn) {
    throw new Error(
      `Code step "${spec.key}" (kind: "code") has no entrypoint.fn. ` +
        `Build it with codeStep({ fn, ... }) from "@scarn/sdk/definitions/steps".`,
    );
  }

  const resolved = toStepSpec(spec);
  delete resolved.entrypoint;
  resolved.entrypointJson = {
    sourceFile: join(PIPELINE_BUILDER_DIR, relative(absDir, absoluteFilePath)),
  };
  return resolved;
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

/** `.ts`/`.js` files in `dir` that declare definitions — excludes internal scripts. */
export function listSourceFiles(absDir: string): string[] {
  const allFiles = readdirSync(absDir).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".js"),
  );
  return allFiles.filter((file) => !INTERNAL_SCRIPT_NAMES.has(file));
}

/** Strips a source file's extension for use as a best-effort display key. */
function fileNameWithoutExtension(file: string): string {
  return file.replace(/\.(ts|js)$/, "");
}

/**
 * Imports one source file and folds whatever it exports into `state` — the
 * per-file body shared by both `collectDefinitionsFromDirectory` (which lets a
 * throw here propagate straight out) and
 * `collectDefinitionsFromDirectoryTolerant` (which catches it per file).
 *
 * Code steps the module exports are registered first, so a key conflict
 * rejects the whole file before any of it is kept.
 */
async function collectFile(
  absoluteFilePath: string,
  absDir: string,
  state: CollectionState,
): Promise<void> {
  const mod = await importModule(absoluteFilePath);

  const environmentEntries = environmentEntriesForFile(
    state,
    environmentHandlesInModule(mod),
    relative(absDir, absoluteFilePath),
  );

  for (const step of stepsInModule(mod)) {
    registerCodeStep(state, step, absoluteFilePath);
  }

  for (const entry of environmentEntries) {
    state.environments.set(entry.handle.name, entry);
  }

  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName === "default" || !isStepDefinitionSpec(value)) continue;
    const resolved = resolveCodeStepEntrypoint(value, absoluteFilePath, absDir);
    state.stepMap.set(`${resolved.key}@v${String(resolved.version)}`, resolved);
  }
}

function collectedEnvironments(state: CollectionState): CollectedEnvironment[] {
  return [...state.environments.values()].map(({ handle, sourceFile }) => ({
    name: handle.name,
    content: handle.content,
    sourceFile,
  }));
}

/**
 * Imports every `.ts`/`.js` file in `dir` (except the push script itself) and
 * collects the step definitions they export.
 *
 * Designed to run on the user's native runtime (bun, node-with-tsx, deno), NOT
 * inside a `bun --compile`'d binary — that runtime can't resolve scoped package
 * `exports` field remappings from external user files. `scarn pipelines
 * studio` works around this for its own compiled binary by never calling this
 * function in-process: `collectDefinitionsViaSubprocess` (in
 * `packages/worker/src/pipelines/pipeline-studio/infra/collect-definitions-via-subprocess.ts`)
 * spawns a real bun/tsx/deno subprocess that calls this exact function from
 * outside the compiled binary. Calling it directly, in-process, from inside a
 * compiled binary is still unsupported.
 *
 * Throws on the first bad file — a syntax error, a step-definition error, a
 * conflicting `codeStep` key — aborting the
 * whole collection. That's the right behavior for `scarn pipelines push`
 * (this function's only real caller besides its own tests): pushing a
 * partially-collected directory would be worse than refusing to push at all.
 * `scarn pipelines studio` wants the opposite trade-off — see
 * `collectDefinitionsFromDirectoryTolerant` below.
 */
export async function collectDefinitionsFromDirectory(
  dir: string,
): Promise<CollectedDefinitions> {
  const absDir = resolve(dir);
  const sourceFiles = listSourceFiles(absDir);

  const state = createCollectionState();

  for (const file of sourceFiles) {
    await collectFile(join(absDir, file), absDir, state);
  }

  return {
    steps: [...state.stepMap.values()],
    environments: collectedEnvironments(state),
  };
}

/**
 * `collectDefinitionsFromDirectory`'s tolerant sibling, built for `scarn
 * pipelines studio`: one file failing to import (a syntax error, a
 * step-definition error, a conflicting `codeStep` key, ...) is recorded as a
 * `BrokenPipeline` entry instead of aborting collection — every *other*
 * file's steps still come back usable, so one bad edit in the builder
 * directory doesn't blank the whole designer (see
 * `compute-studio-snapshot.ts`).
 */
export async function collectDefinitionsFromDirectoryTolerant(
  dir: string,
): Promise<TolerantCollectedDefinitions> {
  const absDir = resolve(dir);
  const sourceFiles = listSourceFiles(absDir);

  const state = createCollectionState();
  const brokenPipelines: BrokenPipeline[] = [];

  for (const file of sourceFiles) {
    try {
      await collectFile(join(absDir, file), absDir, state);
    } catch (error) {
      brokenPipelines.push({
        key: fileNameWithoutExtension(file),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    steps: [...state.stepMap.values()],
    environments: collectedEnvironments(state),
    brokenPipelines,
  };
}
