/**
 * Checks a `when` condition: every reference exists, operators fit the field
 * type, list conditions and computed values are applied to the right shapes.
 */
import {
  jsonPointer,
  type ComputedSource,
  type Condition,
  COMPUTED_FUNCTIONS,
  LIST_OPERATORS,
  ORDERING_OPERATORS,
} from "@scarn/sdk/contracts/pipeline-document";
import { splitPath } from "../references/parse";
import { report, type Site, type ValidationContext } from "./context";
import { resolveReferenceSchema } from "./reference-schema";
import type { Segment } from "./graph";
import {
  ANY,
  isAnySchema,
  itemsSchema,
  onlyTypes,
  propertyNames,
  rooted,
  schemaAtPath,
  withoutNull,
  type RootedSchema,
} from "./json-schema";
import { describeSchema } from "./schema-relations";
import { closest } from "./suggest";
import { checkOperator, operatorError } from "./check-operator";

type Scope = { element?: RootedSchema; label?: string };

const NUMBER_SCHEMA = rooted({ type: "number" });

function readLeft(
  ctx: ValidationContext,
  site: Site,
  scope: Scope,
  path: string,
  pointer: Segment[],
): RootedSchema | null {
  if (scope.element === undefined) {
    return resolveReferenceSchema(ctx, site, path, pointer);
  }
  const segments = splitPath(path);
  const found =
    segments === null ? null : schemaAtPath(scope.element, segments);
  if (found === null) {
    const options = propertyNames(scope.element);
    const suggestion = closest(path, options);
    report(ctx, site, {
      code: "unknown_path",
      path: jsonPointer(pointer),
      message: `"${path}" doesn't exist on the elements of ${scope.label ?? "the list"} (${describeSchema(scope.element)})`,
      ...(suggestion === undefined
        ? {}
        : {
            hint: `Paths inside "where" are relative to the element. Did you mean "${suggestion}"?`,
          }),
    });
  }
  return found;
}

function checkComputed(
  ctx: ValidationContext,
  site: Site,
  scope: Scope,
  fn: string,
  source: ComputedSource,
  weights: number[] | undefined,
  pointer: Segment[],
): void {
  const at = [...pointer, fn];
  if (Array.isArray(source)) {
    source.forEach((path, index) => {
      const schema = readLeft(ctx, site, scope, path, [...at, index]);
      if (
        fn !== "count" &&
        schema !== null &&
        !onlyTypes(withoutNull(schema), ["number"])
      ) {
        report(ctx, site, {
          code: "operator_type",
          path: jsonPointer([...at, index]),
          message: `"${fn}" needs numbers, but "${path}" is ${describeSchema(schema)}`,
        });
      }
    });
    if (weights !== undefined) {
      if (weights.length !== source.length) {
        report(ctx, site, {
          code: "invalid_condition",
          path: jsonPointer([...pointer, "weights"]),
          message: `"weights" has ${String(weights.length)} entries but "avg" has ${String(source.length)} values`,
        });
      } else if (
        weights.some((weight) => weight < 0) ||
        weights.reduce((sum, weight) => sum + weight, 0) <= 0
      ) {
        report(ctx, site, {
          code: "invalid_condition",
          path: jsonPointer([...pointer, "weights"]),
          message: '"weights" must be non-negative with a positive total',
        });
      }
    }
    return;
  }
  if (weights !== undefined) {
    report(ctx, site, {
      code: "invalid_condition",
      path: jsonPointer([...pointer, "weights"]),
      message:
        '"weights" only works with a list of references, not { path, field }',
    });
  }
  const list = readLeft(ctx, site, scope, source.path, [...at, "path"]);
  if (list === null) {
    return;
  }
  if (!onlyTypes(withoutNull(list), ["array"])) {
    report(ctx, site, {
      code: "operator_type",
      path: jsonPointer([...at, "path"]),
      message: `"${fn}" with { path } needs an array, but "${source.path}" is ${describeSchema(list)}`,
    });
    return;
  }
  const element = itemsSchema(withoutNull(list));
  const elementScope: Scope = { element, label: `"${source.path}"` };
  if (source.where !== undefined && fn !== "count") {
    report(ctx, site, {
      code: "invalid_condition",
      path: jsonPointer([...at, "where"]),
      message: `"where" is only allowed with "count"`,
      hint: 'Use "field" to pick the number to combine',
    });
  }
  if (fn === "count") {
    if (source.field !== undefined) {
      report(ctx, site, {
        code: "invalid_condition",
        path: jsonPointer([...at, "field"]),
        message: '"count" takes "where", not "field"',
      });
    }
    if (source.where !== undefined) {
      checkConditionIn(ctx, site, elementScope, source.where, [...at, "where"]);
    }
    return;
  }
  if (source.field === undefined) {
    if (!onlyTypes(withoutNull(element), ["number"])) {
      report(ctx, site, {
        code: "invalid_condition",
        path: jsonPointer(at),
        message: `"${fn}" over "${source.path}" needs a "field" naming the number to read from each element`,
      });
    }
    return;
  }
  const fieldSchema = readLeft(ctx, site, elementScope, source.field, [
    ...at,
    "field",
  ]);
  if (
    fieldSchema !== null &&
    !onlyTypes(withoutNull(fieldSchema), ["number"])
  ) {
    report(ctx, site, {
      code: "operator_type",
      path: jsonPointer([...at, "field"]),
      message: `"${fn}" needs numbers, but "${source.field}" is ${describeSchema(fieldSchema)}`,
    });
  }
}

function checkConditionIn(
  ctx: ValidationContext,
  site: Site,
  scope: Scope,
  condition: Condition,
  pointer: Segment[],
): void {
  if (condition.all !== undefined || condition.any !== undefined) {
    const key = condition.all !== undefined ? "all" : "any";
    (condition.all ?? condition.any ?? []).forEach((child, index) => {
      checkConditionIn(ctx, site, scope, child, [...pointer, key, index]);
    });
    return;
  }
  if (condition.not !== undefined) {
    checkConditionIn(ctx, site, scope, condition.not, [...pointer, "not"]);
    return;
  }
  const op = condition.op ?? "equal";
  const right =
    condition.ref === undefined
      ? null
      : resolveReferenceSchema(ctx, site, condition.ref, [...pointer, "ref"]);
  const fn = COMPUTED_FUNCTIONS.find((name) => condition[name] !== undefined);
  if (fn !== undefined) {
    checkComputed(
      ctx,
      site,
      scope,
      fn,
      condition[fn] as ComputedSource,
      condition.weights,
      pointer,
    );
    if (!ORDERING_OPERATORS.has(op) && op !== "equal" && op !== "notEqual") {
      report(ctx, site, {
        code: "operator_type",
        path: jsonPointer([...pointer, "op"]),
        message: `"${fn}" computes a number, so "${op}" can't be used`,
      });
      return;
    }
    checkOperator(
      ctx,
      site,
      pointer,
      op,
      `"${fn}"`,
      NUMBER_SCHEMA,
      right,
      condition.value,
    );
    return;
  }
  const path = condition.path ?? "";
  const left = readLeft(ctx, site, scope, path, [...pointer, "path"]);
  if (left === null) {
    return;
  }
  if (LIST_OPERATORS.has(op)) {
    const list = withoutNull(left);
    if (!onlyTypes(list, ["array"])) {
      operatorError(ctx, site, pointer, op, `"${path}"`, left, "an array");
      return;
    }
    if (condition.where !== undefined) {
      checkConditionIn(
        ctx,
        site,
        {
          element: isAnySchema(list) ? ANY : itemsSchema(list),
          label: `"${path}"`,
        },
        condition.where,
        [...pointer, "where"],
      );
    }
    return;
  }
  checkOperator(
    ctx,
    site,
    pointer,
    op,
    `"${path}"`,
    left,
    right,
    condition.value,
  );
}

export function checkCondition(
  ctx: ValidationContext,
  site: Site,
  condition: Condition,
  pointer: Segment[],
): void {
  checkConditionIn(ctx, site, {}, condition, pointer);
}
