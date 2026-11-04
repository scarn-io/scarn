/**
 * Validates an automation document against what its routes name: every
 * step `to` is in the step catalog and its args fit the step's input,
 * every pipeline `to` is a pipeline with an active version, and every
 * `attach` names a work-item automation. `when` conditions and arg refs are
 * typed against the rule's event (see {@link resolveEventReference}).
 *
 * The pipeline validator's condition checks are reused as is. Args are
 * checked here rather than with `checkArgs`, which works on graph edges:
 * the rules are the same (none missing, no extras, values fit), but there
 * are no `nodes.*` refs, no `each` and no reach-backs. `.on` and scope rules
 * are checked by `automationDocumentSchema`.
 */
import {
  automationDocumentSchema,
  type AutomationDocument,
  type AutomationEvent,
  type AutomationScope,
  type AutomationTargetJson,
} from "@scarn/sdk/contracts/automation-document";
import {
  jsonPointer,
  type ArgValue,
  type StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import { acceptsExtras, requiredNames } from "../pipelines/validate/check-args";
import {
  checkCondition,
  type ConditionContext,
} from "../pipelines/validate/check-condition";
import type { Segment } from "../pipelines/validate/graph";
import {
  allowsType,
  itemsSchema,
  propertyNames,
  rooted,
  schemaAtPath,
  type RootedSchema,
} from "../pipelines/validate/json-schema";
import {
  describeSchema,
  isAssignable,
  valueMatches,
} from "../pipelines/validate/schema-relations";
import { closest, quoteList } from "../pipelines/validate/suggest";
import type { ValidationError } from "../pipelines/validate/types";
import { eventSite, resolveEventReference } from "./event-refs";

/** What an automation's routes may name. */
export interface AutomationCatalog {
  steps: StepCatalog;
  /** Keys of the pipelines with an active version. */
  pipelines: ReadonlySet<string>;
  /** Scope of every automation in the project, by key (this one included). */
  automations: ReadonlyMap<string, AutomationScope>;
}

export type AutomationValidationResult =
  | { ok: true; document: AutomationDocument; errors: [] }
  | { ok: false; document?: AutomationDocument; errors: ValidationError[] };

interface RuleContext extends ConditionContext {
  catalog: AutomationCatalog;
}

function parseAutomation(
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses an untrusted document at the boundary
  input: unknown,
):
  | { ok: true; document: AutomationDocument }
  | { ok: false; errors: ValidationError[] } {
  const parsed = automationDocumentSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, document: parsed.data };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      code: "schema",
      path: jsonPointer(
        issue.path.map((segment) =>
          typeof segment === "number" ? segment : String(segment),
        ),
      ),
      message: issue.message,
    })),
  };
}

function checkArg(
  ctx: RuleContext,
  event: AutomationEvent,
  arg: ArgValue,
  expected: RootedSchema,
  label: string,
  pointer: Segment[],
): void {
  if (typeof arg === "string") {
    const source = resolveEventReference(ctx, eventSite(), event, arg, pointer);
    if (source !== null && !isAssignable(source, expected)) {
      ctx.errors.push({
        code: "type_mismatch",
        path: jsonPointer(pointer),
        message: `"${arg}" is ${describeSchema(source)}, but ${label} is ${describeSchema(expected)}`,
      });
    }
    return;
  }
  if ("value" in arg) {
    if (!valueMatches(arg.value, expected)) {
      ctx.errors.push({
        code: "type_mismatch",
        path: jsonPointer([...pointer, "value"]),
        message: `${JSON.stringify(arg.value)} doesn't fit ${label} (${describeSchema(expected)})`,
      });
    }
    return;
  }
  if (!allowsType(expected, "array")) {
    ctx.errors.push({
      code: "type_mismatch",
      path: jsonPointer(pointer),
      message: `A list doesn't fit ${label} (${describeSchema(expected)})`,
    });
  }
  const item = itemsSchema(expected);
  arg.list.forEach((element, index) => {
    checkArg(ctx, event, element, item, `each element of ${label}`, [
      ...pointer,
      "list",
      index,
    ]);
  });
}

function checkStepArgs(
  ctx: RuleContext,
  event: AutomationEvent,
  stepKey: string,
  args: Readonly<Record<string, ArgValue>>,
  pointer: Segment[],
): void {
  const contract = ctx.catalog.steps[stepKey];
  if (contract === undefined) {
    return;
  }
  const input = rooted(contract.inputSchema);
  const declared = propertyNames(input);
  const extrasAllowed = acceptsExtras(input);
  for (const [name, arg] of Object.entries(args)) {
    const at = [...pointer, "args", name];
    if (!declared.includes(name) && !extrasAllowed) {
      const suggestion = closest(
        name,
        declared.filter((option) => !(option in args)),
      );
      ctx.errors.push({
        code: "extra_arg",
        path: jsonPointer(at),
        message: `Step "${stepKey}" has no input "${name}"`,
        hint:
          suggestion !== undefined
            ? `Did you mean "${suggestion}"?`
            : declared.length > 0
              ? `Its inputs are ${quoteList(declared)}`
              : "It takes no inputs; remove the arg",
      });
      continue;
    }
    const expected = schemaAtPath(input, [name]) ?? rooted(true);
    checkArg(ctx, event, arg, expected, `"${name}" of step "${stepKey}"`, at);
  }
  for (const name of requiredNames(input)) {
    if (!Object.hasOwn(args, name)) {
      const expected = schemaAtPath(input, [name]) ?? rooted(true);
      ctx.errors.push({
        code: "missing_arg",
        path: jsonPointer([...pointer, "args", name]),
        message: `missing; step "${stepKey}" requires ${name} (${describeSchema(expected)})`,
      });
    }
  }
}

function unknownKey(
  ctx: RuleContext,
  code: ValidationError["code"],
  noun: string,
  key: string,
  options: Iterable<string>,
  pointer: Segment[],
  extra?: string,
): void {
  const suggestion = closest(key, options);
  ctx.errors.push({
    code,
    path: jsonPointer(pointer),
    message: `Unknown ${noun} "${key}"${extra ?? ""}`,
    ...(suggestion === undefined
      ? {}
      : { hint: `Did you mean "${suggestion}"?` }),
  });
}

function checkTarget(
  ctx: RuleContext,
  event: AutomationEvent,
  target: AutomationTargetJson,
  pointer: Segment[],
): void {
  const { catalog } = ctx;
  switch (target.kind) {
    case "step":
      if (catalog.steps[target.to] === undefined) {
        unknownKey(
          ctx,
          "unknown_step",
          "step",
          target.to,
          Object.keys(catalog.steps),
          [...pointer, "to"],
        );
        return;
      }
      checkStepArgs(ctx, event, target.to, target.args ?? {}, pointer);
      return;
    case "pipeline":
      if (!catalog.pipelines.has(target.to)) {
        unknownKey(
          ctx,
          "unknown_pipeline",
          "pipeline",
          target.to,
          catalog.pipelines,
          [...pointer, "to"],
          " (or it has no active version)",
        );
      }
      return;
    case "attach": {
      const scope = catalog.automations.get(target.automation);
      const workItemKeys = [...catalog.automations]
        .filter(([, candidate]) => candidate === "workItem")
        .map(([key]) => key);
      if (scope === undefined) {
        unknownKey(
          ctx,
          "unknown_automation",
          "automation",
          target.automation,
          workItemKeys,
          [...pointer, "automation"],
        );
      } else if (scope !== "workItem") {
        ctx.errors.push({
          code: "unknown_automation",
          path: jsonPointer([...pointer, "automation"]),
          message: `"${target.automation}" is a project automation; only work-item automations can be attached`,
        });
      }
      return;
    }
    case "skip":
      return;
  }
}

/** Validates an automation document against the steps, pipelines and automations its routes name. */
export function validateAutomation(
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses an untrusted document at the boundary
  input: unknown,
  catalog: AutomationCatalog,
): AutomationValidationResult {
  const parsed = parseAutomation(input);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  const { document } = parsed;
  const errors: ValidationError[] = [];
  document.rules.forEach((rule, ruleIndex) => {
    const ctx: RuleContext = {
      errors,
      catalog,
      resolveReference: (site, text, pointer) =>
        resolveEventReference({ errors }, site, rule.event, text, pointer),
    };
    const next: Segment[] = ["rules", ruleIndex, "next"];
    rule.next.routes.forEach((route, routeIndex) => {
      const pointer = [...next, "routes", routeIndex];
      if (route.when !== undefined) {
        checkCondition(ctx, eventSite(), route.when, [...pointer, "when"]);
      }
      checkTarget(ctx, rule.event, route, pointer);
    });
    if (rule.next.otherwise !== undefined) {
      checkTarget(ctx, rule.event, rule.next.otherwise, [...next, "otherwise"]);
    }
  });
  return errors.length === 0
    ? { ok: true, document, errors: [] }
    : { ok: false, document, errors };
}
