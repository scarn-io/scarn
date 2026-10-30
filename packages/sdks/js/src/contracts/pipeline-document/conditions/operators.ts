/** Condition operator and computed-function names, shared by schema, evaluator and validator. */
export const COMPARISON_OPERATORS = [
  "equal",
  "notEqual",
  "lessThan",
  "lessThanInclusive",
  "greaterThan",
  "greaterThanInclusive",
] as const;

export const CONDITION_OPERATORS = [
  ...COMPARISON_OPERATORS,
  "exists",
  "isEmpty",
  "contains",
  "startsWith",
  "endsWith",
  "matches",
  "before",
  "after",
  "some",
  "every",
  "none",
] as const;

export const COMPUTED_FUNCTIONS = [
  "sum",
  "avg",
  "min",
  "max",
  "count",
] as const;

export const ORDERING_OPERATORS = new Set<string>([
  "lessThan",
  "lessThanInclusive",
  "greaterThan",
  "greaterThanInclusive",
]);

export const STRING_OPERATORS = new Set<string>([
  "startsWith",
  "endsWith",
  "matches",
]);
export const DATE_OPERATORS = new Set<string>(["before", "after"]);
export const LIST_OPERATORS = new Set<string>(["some", "every", "none"]);
