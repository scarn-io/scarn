/**
 * Evaluates `when` conditions against a resolved reference context.
 *
 * Returns the boolean outcome plus a {@link ConditionRecord} describing what
 * was checked and with which values, for the visit's `routing_json`.
 *
 * Inside a list condition's or `count`'s `where`, `path` (and the sources of
 * computed values) are relative to the array element; `ref` is always a full
 * reference read from the outer context.
 */
import {
  deepEqual,
  isJsonObject,
  type JsonValue,
  type ComputedFunction,
  type ComputedSource,
  type Condition,
  COMPUTED_FUNCTIONS,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  readPath,
  resolveReferenceString,
  type ReferenceContext,
} from "../references/resolve";
import { splitPath } from "../references/parse";

export const CONDITION_ERROR_NAME = "Scarn.ConditionError";

/** Raised when a computed value has nothing to work on; `catch` can handle it as `Scarn.ConditionError`. */
export class ConditionError extends Error {
  readonly errorName = CONDITION_ERROR_NAME;

  constructor(message: string) {
    super(message);
    this.name = CONDITION_ERROR_NAME;
  }
}

export type ConditionRecord =
  | { kind: "all" | "any"; result: boolean; conditions: ConditionRecord[] }
  | { kind: "not"; result: boolean; condition: ConditionRecord }
  | {
      kind: "compare";
      result: boolean;
      left: {
        path?: string;
        computed?: ComputedFunction;
        value: JsonValue | null;
      };
      op: string;
      right?: { ref?: string; value: JsonValue | null };
    }
  | {
      kind: "list";
      result: boolean;
      path: string;
      op: "some" | "every" | "none";
      length: number;
      matchedIndexes: number[];
    };

export interface ConditionOutcome {
  value: boolean;
  record: ConditionRecord;
}

type Scope = {
  context: ReferenceContext;
  element?: { value: JsonValue | undefined };
};

function readLeftPath(path: string, scope: Scope): JsonValue | undefined {
  if (scope.element === undefined) {
    return resolveReferenceString(path, scope.context);
  }
  return readPath(scope.element.value, splitPath(path) ?? [path]);
}

function isEmptyValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length === 0;
  }
  return isJsonObject(value) && Object.keys(value).length === 0;
}

function compareOrdered(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  op: string,
) {
  const comparable =
    (typeof left === "number" && typeof right === "number") ||
    (typeof left === "string" && typeof right === "string");
  if (!comparable) {
    return false;
  }
  switch (op) {
    case "lessThan":
      return left < right;
    case "lessThanInclusive":
      return left <= right;
    case "greaterThan":
      return left > right;
    default:
      return left >= right;
  }
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return null;
  }
}

/** Applies a non-list operator. Missing values compare as null for equality and fail everything else. */
export function applyOperator(
  op: string,
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean {
  switch (op) {
    case "equal":
      return deepEqual(left ?? null, right ?? null);
    case "notEqual":
      return !deepEqual(left ?? null, right ?? null);
    case "lessThan":
    case "lessThanInclusive":
    case "greaterThan":
    case "greaterThanInclusive":
      return compareOrdered(left, right, op);
    case "exists":
      return left !== undefined && left !== null;
    case "isEmpty":
      return isEmptyValue(left);
    case "contains":
      if (typeof left === "string") {
        return typeof right === "string" && left.includes(right);
      }
      return (
        Array.isArray(left) &&
        left.some((item) => deepEqual(item, right ?? null))
      );
    case "startsWith":
      return (
        typeof left === "string" &&
        typeof right === "string" &&
        left.startsWith(right)
      );
    case "endsWith":
      return (
        typeof left === "string" &&
        typeof right === "string" &&
        left.endsWith(right)
      );
    case "matches": {
      const regex = typeof right === "string" ? safeRegex(right) : null;
      return typeof left === "string" && regex !== null && regex.test(left);
    }
    case "before":
    case "after": {
      if (typeof left !== "string" || typeof right !== "string") {
        return false;
      }
      const leftTime = Date.parse(left);
      const rightTime = Date.parse(right);
      if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
        return false;
      }
      return op === "before" ? leftTime < rightTime : leftTime > rightTime;
    }
    default:
      return false;
  }
}

function elementsAt(path: string, scope: Scope): JsonValue[] {
  const value = readLeftPath(path, scope);
  return Array.isArray(value) ? value : [];
}

function computeValue(
  fn: ComputedFunction,
  source: ComputedSource,
  weights: readonly number[] | undefined,
  scope: Scope,
): number {
  if (Array.isArray(source)) {
    const values = source.map((path) => readLeftPath(path, scope));
    if (fn === "count") {
      return values.filter((value) => value !== undefined && value !== null)
        .length;
    }
    const numbers: { value: number; weight: number }[] = [];
    values.forEach((value, index) => {
      if (typeof value === "number") {
        numbers.push({ value, weight: weights?.[index] ?? 1 });
      }
    });
    return reduceNumbers(fn, numbers);
  }
  const elements = elementsAt(source.path, scope);
  if (fn === "count") {
    const { where } = source;
    if (where === undefined) {
      return elements.length;
    }
    return elements.filter(
      (element) =>
        evaluateIn(where, { ...scope, element: { value: element } }).value,
    ).length;
  }
  const field =
    source.field === undefined
      ? []
      : (splitPath(source.field) ?? [source.field]);
  const numbers = elements
    .map((element) => readPath(element, field))
    .filter((value): value is number => typeof value === "number")
    .map((value) => ({ value, weight: 1 }));
  return reduceNumbers(fn, numbers);
}

function reduceNumbers(
  fn: ComputedFunction,
  numbers: { value: number; weight: number }[],
): number {
  if (fn === "sum") {
    return numbers.reduce((total, entry) => total + entry.value, 0);
  }
  if (numbers.length === 0) {
    throw new ConditionError(`"${fn}" has no numbers to work on`);
  }
  if (fn === "min") {
    return Math.min(...numbers.map((entry) => entry.value));
  }
  if (fn === "max") {
    return Math.max(...numbers.map((entry) => entry.value));
  }
  const totalWeight = numbers.reduce((total, entry) => total + entry.weight, 0);
  if (totalWeight <= 0) {
    throw new ConditionError(
      '"avg" weights of the present values add up to zero',
    );
  }
  return (
    numbers.reduce((total, entry) => total + entry.value * entry.weight, 0) /
    totalWeight
  );
}

function evaluateIn(condition: Condition, scope: Scope): ConditionOutcome {
  if (condition.all !== undefined || condition.any !== undefined) {
    const kind = condition.all !== undefined ? "all" : "any";
    const records: ConditionRecord[] = [];
    let value = kind === "all";
    for (const child of condition.all ?? condition.any ?? []) {
      const outcome = evaluateIn(child, scope);
      records.push(outcome.record);
      if (kind === "all" && !outcome.value) {
        value = false;
        break;
      }
      if (kind === "any" && outcome.value) {
        value = true;
        break;
      }
    }
    return { value, record: { kind, result: value, conditions: records } };
  }
  if (condition.not !== undefined) {
    const inner = evaluateIn(condition.not, scope);
    return {
      value: !inner.value,
      record: { kind: "not", result: !inner.value, condition: inner.record },
    };
  }
  const op = condition.op ?? "equal";
  if (
    (op === "some" || op === "every" || op === "none") &&
    condition.path !== undefined
  ) {
    return evaluateList(condition.path, op, condition.where, scope);
  }
  const fn = COMPUTED_FUNCTIONS.find((name) => condition[name] !== undefined);
  let left: JsonValue | undefined;
  if (fn !== undefined) {
    left = computeValue(
      fn,
      condition[fn] as ComputedSource,
      condition.weights,
      scope,
    );
  } else {
    left =
      condition.path === undefined
        ? undefined
        : readLeftPath(condition.path, scope);
  }
  const right: { ref?: string; value: JsonValue | undefined } | undefined =
    condition.ref !== undefined
      ? {
          ref: condition.ref,
          value: resolveReferenceString(condition.ref, scope.context),
        }
      : condition.value !== undefined
        ? { value: condition.value }
        : undefined;
  const value = applyOperator(op, left, right?.value);
  return {
    value,
    record: {
      kind: "compare",
      result: value,
      left: {
        ...(fn === undefined ? { path: condition.path } : { computed: fn }),
        value: left ?? null,
      },
      op,
      ...(right === undefined
        ? {}
        : {
            right: {
              ...(right.ref === undefined ? {} : { ref: right.ref }),
              value: right.value ?? null,
            },
          }),
    },
  };
}

function evaluateList(
  path: string,
  op: "some" | "every" | "none",
  where: Condition | undefined,
  scope: Scope,
): ConditionOutcome {
  const elements = elementsAt(path, scope);
  const matchedIndexes: number[] = [];
  elements.forEach((element, index) => {
    if (
      where !== undefined &&
      evaluateIn(where, { ...scope, element: { value: element } }).value
    ) {
      matchedIndexes.push(index);
    }
  });
  const value =
    op === "some"
      ? matchedIndexes.length > 0
      : op === "every"
        ? matchedIndexes.length === elements.length
        : matchedIndexes.length === 0;
  return {
    value,
    record: {
      kind: "list",
      result: value,
      path,
      op,
      length: elements.length,
      matchedIndexes,
    },
  };
}

/**
 * Evaluates a condition. Throws {@link ConditionError} when `avg`, `min` or
 * `max` has no numbers to work on, and `ReferenceError` on a malformed
 * reference (which the validator rules out).
 */
export function evaluateCondition(
  condition: Condition,
  context: ReferenceContext,
): ConditionOutcome {
  return evaluateIn(condition, { context });
}
