/**
 * Condition helpers, one per JSON operator, plus `all` / `any` / `not`, the
 * list operators `some` / `every` / `none`, and the computed values `sum`,
 * `avg`, `min`, `max` and `count`. Each helper's right side is typed against
 * its left.
 */
import type {
  ConditionOperator,
  JsonValue,
} from "../contracts/pipeline-document";
import {
  ComputedData,
  ConditionData,
  conditionData,
  requireRef,
  type ComputedValue,
  type Condition,
  type RightNode,
} from "./condition-data";
import { AuthoringError } from "./errors";
import { refData, rootPlaceholder, type RefData } from "./refs";
import type { JsonLiteral, Literal, Placeholder, Ref } from "./ref-types";

export type { Condition, ComputedValue } from "./condition-data";

/** What may be compared with a `T`: a reference of that type or a literal. */
export type Right<T> = [T] extends [never]
  ? Ref<unknown> | JsonLiteral
  : Ref<T> | Literal<T>;

type NumberLeft = Ref<number | null> | ComputedValue;
type StringLeft = Ref<string | null>;

function toCondition(data: ConditionData): Condition {
  return data as unknown as Condition;
}

function toComputed(data: ComputedData): ComputedValue {
  return data as unknown as ComputedValue;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- author values
function right(value: unknown): RightNode {
  const data = refData(value);
  if (data !== undefined) {
    return { kind: "ref", ref: data };
  }
  if (value === undefined) {
    throw new AuthoringError("a condition's right side can't be undefined");
  }
  return { kind: "value", value: value as JsonValue };
}

const NO_RIGHT = Symbol("no right side");

function compare(
  op: ConditionOperator,
  // eslint-disable-next-line local/no-unknown-parameter-type -- author values
  left: unknown,
  // eslint-disable-next-line local/no-unknown-parameter-type -- author values
  value: unknown,
): Condition {
  const leftNode =
    left instanceof ComputedData
      ? ({ kind: "computed", computed: left.node } as const)
      : ({
          kind: "ref",
          ref: requireRef(left, `the left side of "${op}"`),
        } as const);
  return toCondition(
    new ConditionData({
      kind: "compare",
      left: leftNode,
      op,
      right: value === NO_RIGHT ? { kind: "none" } : right(value),
    }),
  );
}

export function equal<T>(left: Ref<T>, value: NoInfer<Right<T>>): Condition;
export function equal(
  left: ComputedValue,
  value: number | Ref<number>,
): Condition;
// eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
export function equal(left: unknown, value: unknown): Condition {
  return compare("equal", left, value);
}

export function notEqual<T>(left: Ref<T>, value: NoInfer<Right<T>>): Condition;
export function notEqual(
  left: ComputedValue,
  value: number | Ref<number>,
): Condition;
// eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
export function notEqual(left: unknown, value: unknown): Condition {
  return compare("notEqual", left, value);
}

export function lessThan(
  left: NumberLeft,
  value: number | Ref<number>,
): Condition {
  return compare("lessThan", left, value);
}

export function lessThanInclusive(
  left: NumberLeft,
  value: number | Ref<number>,
): Condition {
  return compare("lessThanInclusive", left, value);
}

export function greaterThan(
  left: NumberLeft,
  value: number | Ref<number>,
): Condition {
  return compare("greaterThan", left, value);
}

export function greaterThanInclusive(
  left: NumberLeft,
  value: number | Ref<number>,
): Condition {
  return compare("greaterThanInclusive", left, value);
}

export function exists(left: Ref<unknown>): Condition {
  return compare("exists", left, NO_RIGHT);
}

export function isEmpty(
  left: Ref<string | readonly unknown[] | object | null>,
): Condition {
  return compare("isEmpty", left, NO_RIGHT);
}

export function contains(
  left: StringLeft,
  value: string | Ref<string>,
): Condition;
export function contains<E>(
  left: Ref<readonly E[] | null>,
  value: NoInfer<Right<E>>,
): Condition;
// eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
export function contains(left: unknown, value: unknown): Condition {
  return compare("contains", left, value);
}

export function startsWith(
  left: StringLeft,
  value: string | Ref<string>,
): Condition {
  return compare("startsWith", left, value);
}

export function endsWith(
  left: StringLeft,
  value: string | Ref<string>,
): Condition {
  return compare("endsWith", left, value);
}

/** `pattern` is a regular expression source, matched with the `u` flag. */
export function matches(left: StringLeft, pattern: string): Condition {
  return compare("matches", left, pattern);
}

/** Date strings (ISO 8601). */
export function before(
  left: StringLeft,
  date: string | Ref<string>,
): Condition {
  return compare("before", left, date);
}

export function after(left: StringLeft, date: string | Ref<string>): Condition {
  return compare("after", left, date);
}

export function all(...conditions: [Condition, ...Condition[]]): Condition {
  return toCondition(
    new ConditionData({ kind: "all", items: conditions.map(conditionData) }),
  );
}

export function any(...conditions: [Condition, ...Condition[]]): Condition {
  return toCondition(
    new ConditionData({ kind: "any", items: conditions.map(conditionData) }),
  );
}

export function not(condition: Condition): Condition {
  return toCondition(
    new ConditionData({ kind: "not", item: conditionData(condition) }),
  );
}

/** The placeholder for one element of `list`; its paths are relative to the element. */
function element(list: RefData): object {
  const items = typeof list.schema === "object" ? list.schema.items : undefined;
  return rootPlaceholder("", items, { scope: "element" });
}

type ElementCallback<E, R> = (element: Placeholder<E>) => R;
type Selector = (element: never) => object;
type ConditionSelector = (element: never) => Condition;

function select<R>(callback: (element: never) => R, item: object): R {
  return (callback as (element: object) => R)(item);
}

function list<E>(
  op: "some" | "every" | "none",
  over: Ref<readonly E[] | null>,
  where: ElementCallback<E, Condition>,
): Condition {
  const data = requireRef(over, `the list of "${op}"`);
  const item = element(data) as Placeholder<E>;
  return toCondition(
    new ConditionData({
      kind: "list",
      list: data,
      op,
      where: conditionData(where(item)),
    }),
  );
}

export function some<E>(
  over: Ref<readonly E[] | null>,
  where: ElementCallback<E, Condition>,
): Condition {
  return list("some", over, where);
}

export function every<E>(
  over: Ref<readonly E[] | null>,
  where: ElementCallback<E, Condition>,
): Condition {
  return list("every", over, where);
}

export function none<E>(
  over: Ref<readonly E[] | null>,
  where: ElementCallback<E, Condition>,
): Condition {
  return list("none", over, where);
}

type NumberRefs = readonly [Ref<number | null>, ...Ref<number | null>[]];

function reduce(
  fn: "sum" | "avg" | "min" | "max",
  // eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
  source: unknown,
  field: Selector | undefined,
  weights?: number[],
): ComputedValue {
  if (Array.isArray(source)) {
    const refs = source.map((value) =>
      requireRef(value, `each value of "${fn}"`),
    );
    return toComputed(
      new ComputedData(
        weights === undefined ? { fn, refs } : { fn, refs, weights },
      ),
    );
  }
  const data = requireRef(source, `the list of "${fn}"`);
  if (field === undefined) {
    throw new AuthoringError(
      `"${fn}" over a list needs a field selector, for example (x) => x.score`,
    );
  }
  return toComputed(
    new ComputedData({
      fn,
      list: data,
      field: requireRef(select(field, element(data)), `the field of "${fn}"`),
    }),
  );
}

export function sum(values: NumberRefs): ComputedValue;
export function sum<E>(
  over: Ref<readonly E[] | null>,
  field: ElementCallback<E, Ref<number | null>>,
): ComputedValue;
// eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
export function sum(source: unknown, field?: Selector): ComputedValue {
  return reduce("sum", source, field);
}

export function avg(
  values: NumberRefs,
  options?: { weights?: number[] },
): ComputedValue;
export function avg<E>(
  over: Ref<readonly E[] | null>,
  field: ElementCallback<E, Ref<number | null>>,
): ComputedValue;
export function avg(
  // eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
  source: unknown,
  second?: Selector | { weights?: number[] },
): ComputedValue {
  return typeof second === "function"
    ? reduce("avg", source, second)
    : reduce("avg", source, undefined, second?.weights);
}

export function min(values: NumberRefs): ComputedValue;
export function min<E>(
  over: Ref<readonly E[] | null>,
  field: ElementCallback<E, Ref<number | null>>,
): ComputedValue;
// eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
export function min(source: unknown, field?: Selector): ComputedValue {
  return reduce("min", source, field);
}

export function max(values: NumberRefs): ComputedValue;
export function max<E>(
  over: Ref<readonly E[] | null>,
  field: ElementCallback<E, Ref<number | null>>,
): ComputedValue;
// eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
export function max(source: unknown, field?: Selector): ComputedValue {
  return reduce("max", source, field);
}

/** Counts the refs that exist and aren't null, or the list's elements (matching `where`). */
export function count(
  values: readonly [Ref<unknown>, ...Ref<unknown>[]],
): ComputedValue;
export function count<E>(
  over: Ref<readonly E[] | null>,
  where?: ElementCallback<E, Condition>,
): ComputedValue;
export function count(
  // eslint-disable-next-line local/no-unknown-parameter-type -- overload implementation
  source: unknown,
  where?: ConditionSelector,
): ComputedValue {
  if (Array.isArray(source)) {
    const refs = source.map((value) =>
      requireRef(value, 'each value of "count"'),
    );
    return toComputed(new ComputedData({ fn: "count", refs }));
  }
  const data = requireRef(source, 'the list of "count"');
  return toComputed(
    new ComputedData(
      where === undefined
        ? { fn: "count", list: data }
        : {
            fn: "count",
            list: data,
            where: conditionData(select(where, element(data))),
          },
    ),
  );
}
