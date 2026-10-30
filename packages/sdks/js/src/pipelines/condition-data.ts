/**
 * Conditions at run time: data built by the condition helpers and compiled to
 * JSON `when` objects once the pipeline is assembled. Compiling checks that
 * paths inside `some` / `every` / `none` / `count` are relative to the
 * element and paths outside them aren't, and marks every ref it uses.
 */
import type {
  ComputedFunction,
  ComputedSource,
  Condition as JsonCondition,
  ConditionOperator,
  JsonValue,
} from "../contracts/pipeline-document";
import { AuthoringError } from "./errors";
import { refData, useRef, type RefData } from "./refs";
import { captureSite, type SourceSite } from "./source";

export declare const conditionBrand: unique symbol;
export declare const computedBrand: unique symbol;

/** A condition, built with the helpers. Plain JS booleans aren't conditions. */
export interface Condition {
  readonly [conditionBrand]: true;
}

/** A number computed by `sum`, `avg`, `min`, `max` or `count`. */
export interface ComputedValue {
  readonly [computedBrand]: true;
}

export type Scope = "document" | "element";

/** A ref or computed value on the left of a comparison. */
export type LeftNode =
  { kind: "ref"; ref: RefData } | { kind: "computed"; computed: ComputedNode };

export type RightNode =
  | { kind: "none" }
  | { kind: "ref"; ref: RefData }
  | { kind: "value"; value: JsonValue };

export type ConditionNode =
  | { kind: "all" | "any"; items: ConditionData[] }
  | { kind: "not"; item: ConditionData }
  | { kind: "compare"; left: LeftNode; op: ConditionOperator; right: RightNode }
  | {
      kind: "list";
      list: RefData;
      op: ConditionOperator;
      where: ConditionData;
    };

export type ComputedNode =
  | { fn: ComputedFunction; refs: RefData[]; weights?: number[] }
  | {
      fn: ComputedFunction;
      list: RefData;
      field?: RefData;
      where?: ConditionData;
    };

export class ConditionData {
  constructor(
    readonly node: ConditionNode,
    readonly site: SourceSite | null = captureSite(),
  ) {}
}

export class ComputedData {
  constructor(
    readonly node: ComputedNode,
    readonly site: SourceSite | null = captureSite(),
  ) {}
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function conditionData(value: unknown): ConditionData {
  if (value instanceof ConditionData) {
    return value;
  }
  throw new AuthoringError(
    `${typeof value === "boolean" ? "a JS boolean" : "this value"} is not a condition: build conditions with the helpers (equal, greaterThan, all, ...), not JS operators`,
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function requireRef(value: unknown, what: string): RefData {
  const data = refData(value);
  if (data === undefined) {
    throw new AuthoringError(
      `${what} must be a reference (r.result..., r.input..., ...)`,
    );
  }
  return data;
}

function refPath(ref: RefData, scope: Scope, side: "left" | "right"): string {
  if (side === "right" && ref.scope === "element") {
    throw new AuthoringError(
      `"${ref.path}" is relative to a list element and can only be the left side of a condition inside some / every / none / count`,
      ref.record?.site ?? null,
    );
  }
  if (side === "left" && ref.scope !== scope) {
    throw new AuthoringError(
      scope === "element"
        ? `"${ref.path}" is a full reference, but inside some / every / none / count the left side must come from the element parameter`
        : `"${ref.path}" is relative to a list element and can only be used inside that list's callback`,
      ref.record?.site ?? null,
    );
  }
  return useRef(ref);
}

function leftPath(ref: RefData, scope: Scope): string {
  const path = refPath(ref, scope, "left");
  if (path === "") {
    throw new AuthoringError(
      "a condition on the whole element isn't supported; compare one of its fields",
      ref.record?.site ?? null,
    );
  }
  return path;
}

function compileComputed(
  computed: ComputedNode,
  scope: Scope,
): { source: ComputedSource; weights?: number[] } {
  if ("refs" in computed) {
    const source = computed.refs.map((ref) => leftPath(ref, scope));
    return computed.weights === undefined
      ? { source }
      : { source, weights: computed.weights };
  }
  const path = leftPath(computed.list, scope);
  if (computed.field !== undefined) {
    return { source: { path, field: leftPath(computed.field, "element") } };
  }
  if (computed.where !== undefined) {
    return {
      source: { path, where: compileCondition(computed.where, "element") },
    };
  }
  return { source: { path } };
}

function compileRight(right: RightNode): Partial<JsonCondition> {
  switch (right.kind) {
    case "none":
      return {};
    case "value":
      return { value: right.value };
    case "ref":
      return { ref: refPath(right.ref, "document", "right") };
  }
}

/** Compiles a condition to its JSON `when`. Throws `AuthoringError`. */
export function compileCondition(
  data: ConditionData,
  scope: Scope = "document",
): JsonCondition {
  const node = data.node;
  switch (node.kind) {
    case "all":
    case "any":
      return {
        [node.kind]: node.items.map((item) => compileCondition(item, scope)),
      };
    case "not":
      return { not: compileCondition(node.item, scope) };
    case "list":
      return {
        path: leftPath(node.list, scope),
        op: node.op,
        where: compileCondition(node.where, "element"),
      };
    case "compare": {
      if (node.left.kind === "ref") {
        return {
          path: leftPath(node.left.ref, scope),
          op: node.op,
          ...compileRight(node.right),
        };
      }
      const { source, weights } = compileComputed(node.left.computed, scope);
      return {
        [node.left.computed.fn]: source,
        ...(weights === undefined ? {} : { weights }),
        op: node.op,
        ...compileRight(node.right),
      };
    }
  }
}
