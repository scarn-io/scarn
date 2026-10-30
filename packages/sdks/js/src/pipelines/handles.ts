/**
 * Handles at run time: callable functions that record a target when called,
 * with the chain-starting methods attached. Step handles from `defineStep` /
 * `codeStep` and `stepRef` are built here, and so are wait handles.
 */
import type { JsonSchema } from "../contracts/pipeline-document";
import { attachChainMethods } from "./chain";
import { AuthoringError } from "./errors";
import type { NodeDef, RawArgs } from "./model";
import { registerNode, registerTarget } from "./registry";
import { captureSite } from "./source";

/** What `toPipelineStep` needs from a step definition. */
export interface StepSource {
  key: string;
  inputSchemaJson: JsonSchema | Record<string, unknown> | null;
  resultSchemaJson: JsonSchema | Record<string, unknown> | null;
  errors?: readonly string[];
  /** A code step always has a result schema, so only an agent step without one is a conversation step. */
  kind?: "built_in" | "user_defined" | "code";
}

function checkArgs(node: NodeDef, args: RawArgs | undefined): void {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JS callers
  if (args !== undefined && (typeof args !== "object" || args === null)) {
    throw new AuthoringError(`args for "${node.id}" must be an object`);
  }
}

function targetFn(node: NodeDef): (args?: RawArgs) => object {
  return (args?: RawArgs) => {
    checkArgs(node, args);
    return registerTarget(
      Object.freeze({ _tag: "pipeline_target", to: node.id }),
      { node, args, site: captureSite() },
    );
  };
}

function partialFn(node: NodeDef): (args: RawArgs) => object {
  return (args: RawArgs) => {
    checkArgs(node, args);
    return registerTarget(
      Object.freeze({ _tag: "pipeline_partial", to: node.id }),
      { node, args, site: captureSite(), partial: true },
    );
  };
}

/** Makes `handle` a pipeline handle for `node`: chain methods, `.partial`, and `.as` for steps. */
export function makeHandle<T extends object>(handle: T, node: NodeDef): T {
  attachChainMethods(handle, node);
  registerNode(handle, node);
  Object.defineProperty(handle, "partial", {
    value: partialFn(node),
    enumerable: false,
    configurable: true,
  });
  if (node.kind === "step") {
    Object.defineProperty(handle, "as", {
      value: (id: string) =>
        stepHandleFor({ ...node, id, site: captureSite() }),
      enumerable: false,
      configurable: true,
    });
  }
  return handle;
}

function stepHandleFor(node: NodeDef): object {
  const handle = targetFn(node);
  if (node.kind === "step") {
    Object.defineProperties(handle, {
      key: { value: node.step, enumerable: true },
      inputSchemaJson: { value: node.inputSchema, enumerable: true },
      resultSchemaJson: { value: node.resultSchema, enumerable: true },
      errors: { value: node.errors, enumerable: true },
    });
  }
  return makeHandle(handle, node);
}

/**
 * The call behind a step handle: records a target for `source`'s node. Used
 * by `toStepHandle` so `defineStep` / `codeStep` handles are pipeline steps.
 */
export function stepNode(source: StepSource, local = true): NodeDef {
  return {
    kind: "step",
    id: source.key,
    step: source.key,
    local,
    inputSchema: source.inputSchemaJson ?? null,
    resultSchema: source.resultSchemaJson ?? null,
    conversation:
      local && source.kind !== "code" && source.resultSchemaJson === null,
    errors: [...(source.errors ?? [])],
    site: captureSite(),
  };
}

/** A callable step handle for `node`, without the handle's own spec fields. */
export function stepCall(node: NodeDef): (args?: RawArgs) => object {
  return targetFn(node);
}

/** A callable wait or terminal-free handle, with chain methods. */
export function waitHandle(node: NodeDef): object {
  return makeHandle(targetFn(node), node);
}

/** A fresh step handle for a step known only by key. */
export function bareStepHandle(source: StepSource, local: boolean): object {
  return stepHandleFor(stepNode(source, local));
}
