import { processProjectWork as processProjectWorkInCore } from "./process-project-work";
import type { ProcessProjectWorkResult } from "../contracts/process-project-work-types";
import type { LocalRuntimeSessionStore } from "../infra/sqlite-local-runtime-session-store";
import { createDefaultProjectWorkDeps } from "./default-project-work-deps";
import {
  buildProjectWorkSetup,
  type ProjectWorkHostDeps,
  type ProjectWorkOptions,
} from "./project-work-setup";

export type ProcessProjectWorkOptions = ProjectWorkOptions;
export type ProcessProjectWorkDeps = ProjectWorkHostDeps;

/**
 * Runs one project loop in the foreground: builds the setup (production
 * dependencies unless `deps` is given), runs the loop until it returns, and
 * closes what the setup opened.
 */
export async function runProjectWork(
  options: ProcessProjectWorkOptions,
  deps?: ProcessProjectWorkDeps,
): Promise<ProcessProjectWorkResult> {
  const setup = await buildProjectWorkSetup(
    options,
    deps ?? createDefaultProjectWorkDeps(options.dest, options.reporter),
  );
  try {
    return await processProjectWorkInCore(setup.input, setup.deps);
  } finally {
    setup.close();
  }
}

export const processProjectWork = runProjectWork;

export type { ProcessProjectWorkResult };
export type { LocalRuntimeSessionStore };
