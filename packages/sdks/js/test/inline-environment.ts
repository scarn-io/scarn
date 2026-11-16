import type { CompiledEnvironment } from "../src/definitions/steps/runtime";

export function inlineEnvironment(environment: CompiledEnvironment) {
  if (environment?.kind === "named") {
    throw new Error(
      `Expected inline environment, received "${environment.name}"`,
    );
  }
  return environment;
}
