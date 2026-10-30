import { expect } from "bun:test";
import {
  type StepCatalog,
  type StepContract,
} from "@scarn/sdk/contracts/pipeline-document";
import { validatePipeline, type ValidationError } from "../../src/pipelines";
import type { Doc } from "./fixtures";

/** Validates and returns the errors, so tests can assert on paths and codes. */
export function errorsOf(
  document: object,
  steps: StepCatalog,
): ValidationError[] {
  return validatePipeline(document, steps).errors;
}

export function pathsOf(errors: readonly ValidationError[]): string[] {
  return errors.map((error) => error.path);
}

export function findError(
  errors: readonly ValidationError[],
  path: string,
): ValidationError | undefined {
  return errors.find((error) => error.path === path);
}

export interface ExpectedError {
  path: string;
  code?: ValidationError["code"];
  message?: string;
  hint?: string;
  messageIncludes?: string;
  hintIncludes?: string;
}

/** Asserts that an error exists at `path` with the given fields. */
export function expectError(
  errors: readonly ValidationError[],
  expected: ExpectedError,
): void {
  const candidates = errors.filter(
    (error) =>
      error.path === expected.path &&
      (expected.code === undefined || error.code === expected.code),
  );
  expect(candidates.map((error) => error.path)).toContain(expected.path);
  const [error] = candidates;
  if (expected.message !== undefined) {
    expect(error?.message).toBe(expected.message);
  }
  if (expected.hint !== undefined) {
    expect(error?.hint).toBe(expected.hint);
  }
  if (expected.messageIncludes !== undefined) {
    expect(error?.message).toContain(expected.messageIncludes);
  }
  if (expected.hintIncludes !== undefined) {
    expect(error?.hint).toContain(expected.hintIncludes);
  }
}

export function stepOf(steps: StepCatalog, name: string): StepContract {
  const step = steps[name];
  if (step === undefined) {
    throw new Error(`fixture step "${name}" is missing`);
  }
  return step;
}

/**
 * Navigates a fixture to a node's route for mutation. `index` counts the
 * routes in order, then `otherwise`.
 */
export function nextOf(
  document: Doc,
  nodeId: string,
  index: number,
): Record<string, unknown> {
  const node = document.nodes[nodeId] as {
    next: {
      routes: Record<string, unknown>[];
      otherwise?: Record<string, unknown>;
    };
  };
  const { routes, otherwise } = node.next;
  const route = index < routes.length ? routes[index] : otherwise;
  if (route === undefined) {
    throw new Error(`fixture node "${nodeId}" has no route ${String(index)}`);
  }
  return route;
}

export function argsOf(
  document: Doc,
  nodeId: string,
  index: number,
): Record<string, unknown> {
  return nextOf(document, nodeId, index)["args"] as Record<string, unknown>;
}
