/** Operator and literal checks for `when` conditions: the operator fits the field type and the literal can match it. */
import {
  jsonPointer,
  type JsonValue,
  DATE_OPERATORS,
  ORDERING_OPERATORS,
  STRING_OPERATORS,
} from "@scarn/sdk/contracts/pipeline-document";
import { report, type Site, type ValidationContext } from "./context";
import type { Segment } from "./graph";
import {
  allowsType,
  isAnySchema,
  itemsSchema,
  onlyTypes,
  typeOfValue,
  withoutNull,
  type RootedSchema,
} from "./json-schema";
import { describeSchema, valueMatches } from "./schema-relations";

export function operatorError(
  ctx: ValidationContext,
  site: Site,
  pointer: Segment[],
  op: string,
  left: string,
  schema: RootedSchema,
  expected: string,
): void {
  report(ctx, site, {
    code: "operator_type",
    path: jsonPointer([...pointer, "op"]),
    message: `"${op}" needs ${expected}, but ${left} is ${describeSchema(schema)}`,
  });
}

export function checkOperator(
  ctx: ValidationContext,
  site: Site,
  pointer: Segment[],
  op: string,
  leftLabel: string,
  leftSchema: RootedSchema,
  right: RootedSchema | null,
  literal: JsonValue | undefined,
): void {
  const left = withoutNull(leftSchema);
  if (isAnySchema(left)) {
    return;
  }
  if (
    ORDERING_OPERATORS.has(op) &&
    !onlyTypes(left, ["number"]) &&
    !onlyTypes(left, ["string"])
  ) {
    operatorError(
      ctx,
      site,
      pointer,
      op,
      leftLabel,
      leftSchema,
      "a number or string",
    );
    return;
  }
  if (STRING_OPERATORS.has(op) && !onlyTypes(left, ["string"])) {
    operatorError(ctx, site, pointer, op, leftLabel, leftSchema, "a string");
    return;
  }
  if (DATE_OPERATORS.has(op) && !onlyTypes(left, ["string"])) {
    operatorError(
      ctx,
      site,
      pointer,
      op,
      leftLabel,
      leftSchema,
      "a date string",
    );
    return;
  }
  if (
    op === "contains" &&
    !onlyTypes(left, ["string"]) &&
    !onlyTypes(left, ["array"])
  ) {
    operatorError(
      ctx,
      site,
      pointer,
      op,
      leftLabel,
      leftSchema,
      "a string or an array",
    );
    return;
  }
  if (
    op === "isEmpty" &&
    !onlyTypes(left, ["string", "array", "object", "null"])
  ) {
    operatorError(
      ctx,
      site,
      pointer,
      op,
      leftLabel,
      leftSchema,
      "a string, array or object",
    );
    return;
  }
  if (op === "matches" && typeof literal === "string") {
    try {
      new RegExp(literal, "u");
    } catch {
      report(ctx, site, {
        code: "invalid_condition",
        path: jsonPointer([...pointer, "value"]),
        message: `${JSON.stringify(literal)} is not a valid regular expression`,
      });
    }
    return;
  }
  if (literal !== undefined) {
    checkLiteral(ctx, site, pointer, op, left, leftLabel, literal);
    return;
  }
  if (
    right !== null &&
    !isAnySchema(right) &&
    (ORDERING_OPERATORS.has(op) || op === "equal" || op === "notEqual")
  ) {
    const leftNumber = onlyTypes(left, ["number"]);
    const rightNumber = onlyTypes(right, ["number"]);
    const comparable =
      op === "equal" || op === "notEqual"
        ? [
            "string",
            "number",
            "integer",
            "boolean",
            "object",
            "array",
            "null",
          ].some(
            (type) =>
              allowsType(left, type as "string") &&
              allowsType(right, type as "string"),
          )
        : leftNumber === rightNumber;
    if (!comparable) {
      report(ctx, site, {
        code: "operator_type",
        path: jsonPointer([...pointer, "ref"]),
        message: `${leftLabel} (${describeSchema(leftSchema)}) can't be compared with "${op}" to ${describeSchema(right)}`,
      });
    }
  }
}

export function checkLiteral(
  ctx: ValidationContext,
  site: Site,
  pointer: Segment[],
  op: string,
  left: RootedSchema,
  leftLabel: string,
  literal: JsonValue,
): void {
  const at = jsonPointer([...pointer, "value"]);
  if (op === "contains" && onlyTypes(left, ["array"])) {
    const items = itemsSchema(left);
    if (!valueMatches(literal, items)) {
      report(ctx, site, {
        code: "type_mismatch",
        path: at,
        message: `${JSON.stringify(literal)} can never be an element of ${leftLabel} (${describeSchema(left)})`,
      });
    }
    return;
  }
  if (op === "contains" || STRING_OPERATORS.has(op) || DATE_OPERATORS.has(op)) {
    if (typeof literal !== "string") {
      report(ctx, site, {
        code: "type_mismatch",
        path: at,
        message: `"${op}" compares with a string, got ${JSON.stringify(literal)}`,
      });
    } else if (DATE_OPERATORS.has(op) && Number.isNaN(Date.parse(literal))) {
      report(ctx, site, {
        code: "type_mismatch",
        path: at,
        message: `${JSON.stringify(literal)} is not a date`,
        hint: 'Use an ISO 8601 date such as "2026-01-31T00:00:00Z"',
      });
    }
    return;
  }
  if (ORDERING_OPERATORS.has(op)) {
    const ok = onlyTypes(left, ["number"])
      ? typeof literal === "number"
      : typeof literal === "string";
    if (!ok) {
      report(ctx, site, {
        code: "type_mismatch",
        path: at,
        message: `${leftLabel} is ${describeSchema(left)}, so it can't be compared with ${JSON.stringify(literal)}`,
      });
    }
    return;
  }
  if (
    (op === "equal" || op === "notEqual") &&
    literal !== null &&
    !valueMatches(literal, left)
  ) {
    report(ctx, site, {
      code: "type_mismatch",
      path: at,
      message: `${leftLabel} is ${describeSchema(left)}, so it can never equal ${JSON.stringify(literal)} (${typeOfValue(literal)})`,
    });
  }
}
