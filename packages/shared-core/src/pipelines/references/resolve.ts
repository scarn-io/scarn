/**
 * Resolves parsed references against runtime values. Pure: the caller
 * supplies the context, including how to find a reached-back node's values
 * (the engine walks the visit chain; tests pass a plain record).
 */
import {
  isJsonObject,
  type JsonValue,
} from "@scarn/sdk/contracts/pipeline-document";
import { parseReference, type Reference } from "./parse";

export interface NodeValues {
  result?: JsonValue;
  input?: JsonValue;
}

export interface ReferenceContext {
  result?: JsonValue;
  input?: JsonValue;
  item?: JsonValue;
  error?: { name: string; message: string; cause?: JsonValue };
  nodes?:
    | Readonly<Record<string, NodeValues>>
    | ((nodeId: string) => NodeValues | undefined);
  workItem?: {
    title: string;
    description: string | null;
    fields: Readonly<Record<string, JsonValue>>;
  };
}

export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceError";
  }
}

/** Reads a relative path from a value. `length` works on arrays and strings. Missing gives undefined. */
export function readPath(
  value: JsonValue | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let current = value;
  for (const segment of path) {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
      } else if (/^\d+$/.test(segment)) {
        current = current[Number(segment)];
      } else {
        return undefined;
      }
    } else if (typeof current === "string") {
      if (segment !== "length") {
        return undefined;
      }
      current = current.length;
    } else if (isJsonObject(current)) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

function lookupNode(
  context: ReferenceContext,
  nodeId: string,
): NodeValues | undefined {
  const { nodes } = context;
  if (nodes === undefined) {
    return undefined;
  }
  return typeof nodes === "function" ? nodes(nodeId) : nodes[nodeId];
}

export function resolveReference(
  reference: Reference,
  context: ReferenceContext,
): JsonValue | undefined {
  switch (reference.kind) {
    case "result":
    case "input":
    case "item":
      return readPath(context[reference.kind], reference.path);
    case "error": {
      if (context.error === undefined) {
        return undefined;
      }
      const { name, message, cause } = context.error;
      const errorValue: JsonValue =
        cause === undefined ? { name, message } : { name, message, cause };
      return readPath(errorValue, reference.path);
    }
    case "node": {
      const node = lookupNode(context, reference.nodeId);
      return node === undefined
        ? undefined
        : readPath(node[reference.source], reference.path);
    }
    case "workItemTitle":
      return context.workItem?.title;
    case "workItemDescription":
      return context.workItem?.description;
    case "workItemField": {
      const fields = context.workItem?.fields;
      if (fields === undefined || !Object.hasOwn(fields, reference.alias)) {
        return undefined;
      }
      return readPath(fields[reference.alias], reference.path);
    }
  }
}

/** Parses and resolves a reference string; throws {@link ReferenceError} on a malformed string. */
export function resolveReferenceString(
  text: string,
  context: ReferenceContext,
): JsonValue | undefined {
  const parsed = parseReference(text);
  if (!parsed.ok) {
    throw new ReferenceError(parsed.message);
  }
  return resolveReference(parsed.reference, context);
}

type ScalarArg = string | { value: JsonValue };

export type Arg = ScalarArg | { list: readonly ScalarArg[] };

function resolveScalar(
  arg: ScalarArg,
  context: ReferenceContext,
): JsonValue | undefined {
  return typeof arg === "string"
    ? resolveReferenceString(arg, context)
    : arg.value;
}

/** Resolves one arg. A `list` element that resolves to nothing is left out. */
export function resolveArg(
  arg: Arg,
  context: ReferenceContext,
): JsonValue | undefined {
  if (typeof arg === "object" && "list" in arg) {
    return arg.list
      .map((element) => resolveScalar(element, context))
      .filter((value): value is JsonValue => value !== undefined);
  }
  return resolveScalar(arg, context);
}

/** Resolves transition args: references are read from the context, `{ value }` literals are copied, `{ list }` builds an array. */
export function resolveArgs(
  args: Readonly<Record<string, Arg>> | undefined,
  context: ReferenceContext,
): Record<string, JsonValue> {
  const resolved: Record<string, JsonValue> = {};
  for (const [name, arg] of Object.entries(args ?? {})) {
    const value = resolveArg(arg, context);
    if (value !== undefined) {
      resolved[name] = value;
    }
  }
  return resolved;
}
