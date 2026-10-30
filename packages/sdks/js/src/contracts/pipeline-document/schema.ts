/**
 * The zod schema for pipeline JSON documents (schema version 1) and the JSON
 * Schema exported from it.
 *
 * The schema checks structure only. Features that are in the format but not
 * in v1 (retry delays, wait timeouts, pipeline timeouts, event/timer waits,
 * routing to another pipeline) are accepted here and rejected by the
 * validator, so their errors carry a clear "not supported in v1" message.
 */
import { z } from "zod";
import type { JsonValue } from "./json";
import {
  CONDITION_OPERATORS,
  COMPUTED_FUNCTIONS,
} from "./conditions/operators";

export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const ALIAS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const nodeIdSchema = z
  .string()
  .regex(
    NODE_ID_PATTERN,
    "Node ids may only contain letters, digits, '_' and '-'",
  );

const jsonValueSchema: z.ZodType<JsonValue> = z.json();

export const literalSchema = z.strictObject({ value: jsonValueSchema });

const scalarArgSchema = z.union([z.string().min(1), literalSchema]);

/** An array built from references and literals, one element each. */
export const listSchema = z.strictObject({ list: z.array(scalarArgSchema) });

/** A reference string, `{ "value": ... }` for a literal, or `{ "list": [...] }`. */
export const argValueSchema = z.union([
  z.string().min(1),
  literalSchema,
  listSchema,
]);

export const computedSourceSchema = z.union([
  z.array(z.string().min(1)).min(1),
  z.strictObject({
    path: z.string().min(1),
    field: z.string().min(1).optional(),
    get where() {
      return conditionSchema.optional();
    },
  }),
]);

/**
 * One condition. All keys are optional at the structural level; which
 * combinations are allowed (one left side, `value` xor `ref`, `where` only
 * with list operators, ...) is checked by the refinement below so errors
 * point at the exact key instead of an opaque union failure.
 */
export interface Condition {
  all?: Condition[];
  any?: Condition[];
  not?: Condition;
  path?: string;
  sum?: ComputedSource;
  avg?: ComputedSource;
  min?: ComputedSource;
  max?: ComputedSource;
  count?: ComputedSource;
  weights?: number[];
  op?: ConditionOperator;
  value?: JsonValue;
  ref?: string;
  where?: Condition;
}

export type ComputedSource =
  string[] | { path: string; field?: string; where?: Condition };

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export type ComputedFunction = (typeof COMPUTED_FUNCTIONS)[number];

const LIST_OPS = new Set<string>(["some", "every", "none"]);
const UNARY_OPS = new Set<string>(["exists", "isEmpty"]);

export const conditionSchema: z.ZodType<Condition> = z
  .strictObject({
    get all() {
      return z.array(conditionSchema).min(1).optional();
    },
    get any() {
      return z.array(conditionSchema).min(1).optional();
    },
    get not() {
      return conditionSchema.optional();
    },
    path: z.string().min(1).optional(),
    sum: computedSourceSchema.optional(),
    avg: computedSourceSchema.optional(),
    min: computedSourceSchema.optional(),
    max: computedSourceSchema.optional(),
    count: computedSourceSchema.optional(),
    weights: z.array(z.number()).min(1).optional(),
    op: z.enum(CONDITION_OPERATORS).optional(),
    value: jsonValueSchema.optional(),
    ref: z.string().min(1).optional(),
    get where() {
      return conditionSchema.optional();
    },
  })
  .superRefine((condition, ctx) => {
    const combinators = (["all", "any", "not"] as const).filter(
      (key) => condition[key] !== undefined,
    );
    const lefts = (["path", ...COMPUTED_FUNCTIONS] as const).filter(
      (key) => condition[key] !== undefined,
    );
    if (combinators.length > 0) {
      const extras = Object.keys(condition).filter(
        (key) => key !== combinators[0],
      );
      if (combinators.length > 1 || extras.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `A condition with "${String(combinators[0])}" can't have other keys (found ${[...combinators.slice(1), ...extras].map((key) => `"${key}"`).join(", ")})`,
        });
      }
      return;
    }
    if (lefts.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          lefts.length === 0
            ? 'A condition needs exactly one of "path", "sum", "avg", "min", "max", "count", or a combinator "all", "any", "not"'
            : `A condition can have only one of ${lefts.map((key) => `"${key}"`).join(", ")}`,
      });
      return;
    }
    if (condition.op === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'A condition needs "op"',
        path: ["op"],
      });
      return;
    }
    const isList = LIST_OPS.has(condition.op);
    const isUnary = UNARY_OPS.has(condition.op);
    if (isList && condition.where === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `"${condition.op}" needs a "where" condition`,
        path: ["where"],
      });
    }
    if (!isList && condition.where !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `"where" is only allowed with "some", "every" or "none", not "${condition.op}"`,
        path: ["where"],
      });
    }
    const hasValue = condition.value !== undefined;
    const hasRef = condition.ref !== undefined;
    if ((isList || isUnary) && (hasValue || hasRef)) {
      ctx.addIssue({
        code: "custom",
        message: `"${condition.op}" takes no "value" or "ref"`,
        path: [hasValue ? "value" : "ref"],
      });
    }
    if (!isList && !isUnary && hasValue === hasRef) {
      ctx.addIssue({
        code: "custom",
        message: `"${condition.op}" needs exactly one of "value" or "ref"`,
      });
    }
    if (condition.weights !== undefined && condition.avg === undefined) {
      ctx.addIssue({
        code: "custom",
        message: '"weights" is only allowed with "avg"',
        path: ["weights"],
      });
    }
  });

export const toleratedFailuresSchema = z.union([
  z.strictObject({ count: z.int().nonnegative() }),
  z.strictObject({ percent: z.number().min(0).max(100) }),
]);

export const eachSchema = z.strictObject({
  over: z.string().min(1),
  maxConcurrency: z.int().positive().optional(),
  /** How many item lanes may fail before the run fails. Defaults to `{ count: 0 }`. */
  toleratedFailures: toleratedFailuresSchema.optional(),
});

const routeShape = {
  when: conditionSchema.optional(),
  to: nodeIdSchema,
  pipeline: z.string().min(1).optional(),
  args: z.record(z.string().min(1), argValueSchema).optional(),
  each: eachSchema.optional(),
  /** Ends the lane by contributing these args to the merge at `to`. */
  partial: z.literal(true).optional(),
};

function noPartialWithEach(
  route: { each?: unknown; partial?: true },
  ctx: z.core.$RefinementCtx,
): void {
  if (route.each !== undefined && route.partial !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: 'A route can\'t have both "each" and "partial"',
      path: ["partial"],
    });
  }
}

export const routeSchema = z
  .strictObject(routeShape)
  .superRefine(noPartialWithEach);

/** The route taken when no route matched. It has no `when`. */
export const otherwiseSchema = z
  .strictObject(routeShape)
  .omit({ when: true })
  .superRefine(noPartialWithEach);

/** The pipeline's first route. It can't split or merge. */
export const startSchema = z.strictObject(routeShape).omit({ partial: true });

/**
 * How a node picks its routes: `"first"` (the default) takes the first
 * match, `"all"` takes every match, each as a lane.
 */
export const MATCH_MODES = ["first", "all"] as const;

export const nextSchema = z.strictObject({
  match: z.enum(MATCH_MODES).optional(),
  routes: z.array(routeSchema).min(1),
  otherwise: otherwiseSchema.optional(),
});

export const retrySchema = z.strictObject({
  on: z.array(z.string().min(1)).min(1),
  maxAttempts: z.int().positive(),
  intervalSeconds: z.number().nonnegative().optional(),
  backoffRate: z.number().positive().optional(),
  maxDelaySeconds: z.number().nonnegative().optional(),
});

export const catchSchema = z.strictObject({
  on: z.array(z.string().min(1)).min(1),
  to: nodeIdSchema,
  pipeline: z.string().min(1).optional(),
  args: z.record(z.string().min(1), argValueSchema).optional(),
});

export const stepNodeSchema = z.strictObject({
  kind: z.literal("step"),
  title: z.string().optional(),
  step: z.string().min(1),
  next: nextSchema.optional(),
  retry: z.array(retrySchema).optional(),
  catch: z.array(catchSchema).optional(),
  timeoutSeconds: z.int().positive().optional(),
  heartbeatSeconds: z.int().positive().optional(),
  maxRuns: z.int().positive().optional(),
  /** How many times one visit may hand the floor to a person; 0 turns hand-offs off. Defaults to `DEFAULT_MAX_TURNS`. */
  maxTurns: z.int().nonnegative().optional(),
});

/** A step node's `maxTurns` when the document leaves it out. */
export const DEFAULT_MAX_TURNS = 2;

/** Whether a decision action needs a body. A missing `body` means `"optional"`. */
export const DECISION_BODY_MODES = ["optional", "required"] as const;

/** One choice a `decision` wait offers, in button order. */
export const decisionActionSchema = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  body: z.enum(DECISION_BODY_MODES).optional(),
});

export const waitNodeSchema = z.strictObject({
  kind: z.literal("wait"),
  title: z.string().optional(),
  for: z.enum(["decision", "reply", "event", "timer"]),
  /** The actions of a `decision` wait; not allowed on other waits. */
  actions: z.array(decisionActionSchema).optional(),
  next: nextSchema.optional(),
  catch: z.array(catchSchema).optional(),
  timeoutSeconds: z.int().positive().optional(),
  maxRuns: z.int().positive().optional(),
});

export const succeedNodeSchema = z.strictObject({
  kind: z.literal("succeed"),
  title: z.string().optional(),
});

export const failNodeSchema = z.strictObject({
  kind: z.literal("fail"),
  title: z.string().optional(),
  error: z.string().min(1).optional(),
  cause: z.string().optional(),
});

export const nodeSchema = z.discriminatedUnion("kind", [
  stepNodeSchema,
  waitNodeSchema,
  succeedNodeSchema,
  failNodeSchema,
]);

export const pipelineDocumentSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  key: z.string().min(1),
  title: z.string().optional(),
  timeoutSeconds: z.int().positive().optional(),
  workItemFields: z
    .record(
      z
        .string()
        .regex(
          ALIAS_PATTERN,
          "Aliases must be identifiers (letters, digits, '_')",
        ),
      z.string().min(1),
    )
    .optional(),
  start: startSchema,
  nodes: z.record(nodeIdSchema, nodeSchema),
});

export type ArgValue = z.infer<typeof argValueSchema>;
export type ListArg = z.infer<typeof listSchema>;
export type Each = z.infer<typeof eachSchema>;
export type ToleratedFailures = z.infer<typeof toleratedFailuresSchema>;
export type Route = z.infer<typeof routeSchema>;
export type Otherwise = z.infer<typeof otherwiseSchema>;
export type Start = z.infer<typeof startSchema>;
export type Next = z.infer<typeof nextSchema>;
export type MatchMode = (typeof MATCH_MODES)[number];
export type Retry = z.infer<typeof retrySchema>;
export type Catch = z.infer<typeof catchSchema>;
export type StepNode = z.infer<typeof stepNodeSchema>;
export type WaitNode = z.infer<typeof waitNodeSchema>;
export type DecisionAction = z.infer<typeof decisionActionSchema>;
export type DecisionBody = (typeof DECISION_BODY_MODES)[number];
export type SucceedNode = z.infer<typeof succeedNodeSchema>;
export type FailNode = z.infer<typeof failNodeSchema>;
export type PipelineNode = z.infer<typeof nodeSchema>;
export type PipelineDocument = z.infer<typeof pipelineDocumentSchema>;

/** The JSON Schema for pipeline documents, for editors and external tools. */
export function pipelineDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(pipelineDocumentSchema, { io: "input" });
}
