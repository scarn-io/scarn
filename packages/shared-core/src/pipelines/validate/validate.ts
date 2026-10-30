/**
 * The pipeline validator: a pure function from a JSON document and the step
 * contracts it uses to a list of errors with JSON pointers and fix hints.
 * The CLI, API and UI all call it, so local and server validation agree.
 */
import {
  BUILT_IN_ERRORS,
  jsonPointer,
  routeEntries,
  WAIT_ERRORS,
  type PipelineDocument,
  type Route,
  type StepCatalog,
  type StepNode,
  type WaitNode,
} from "@scarn/sdk/contracts/pipeline-document";
import { checkArgs } from "./check-args";
import { checkCondition } from "./check-condition";
import {
  inputSchemaOf,
  siteFor,
  transitionOf,
  type ValidationContext,
} from "./context";
import { resolveReferenceSchema } from "./reference-schema";
import { buildGraph, checkReachBacks, reachableFrom, type Edge } from "./graph";
import {
  allowsType,
  deref,
  isAnySchema,
  onlyTypes,
  schemaAtPath,
  withoutNull,
} from "./json-schema";
import { describeSchema } from "./schema-relations";
import { analyzeSplits, type Merge } from "./splits";
import { checkDecisionActions, checkNotInV1, parseDocument } from "./structure";
import { closest, quoteList } from "./suggest";
import type { ValidationError } from "./types";

export type ValidationResult =
  | { ok: true; document: PipelineDocument; errors: [] }
  | { ok: false; document?: PipelineDocument; errors: ValidationError[] };

function checkTargets(
  document: PipelineDocument,
  edgesTo: { to: string; pointer: (string | number)[] }[],
) {
  const ids = Object.keys(document.nodes);
  return edgesTo
    .filter((edge) => !Object.hasOwn(document.nodes, edge.to))
    .map((edge): ValidationError => {
      const suggestion = closest(edge.to, ids);
      return {
        code: "unknown_node",
        path: jsonPointer([...edge.pointer, "to"]),
        message: `"${edge.to}" is not a node in this pipeline`,
        hint:
          suggestion === undefined
            ? `Add a node "${edge.to}" under "nodes", or point at one of ${quoteList(ids)}`
            : `Did you mean "${suggestion}"?`,
      };
    });
}

function allTargets(document: PipelineDocument) {
  const targets: { to: string; pointer: (string | number)[] }[] = [
    { to: document.start.to, pointer: ["start"] },
  ];
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.kind !== "step" && node.kind !== "wait") {
      continue;
    }
    for (const entry of routeEntries(node.next)) {
      targets.push({
        to: entry.route.to,
        pointer: ["nodes", id, "next", ...entry.pointer],
      });
    }
    (node.catch ?? []).forEach((entry, index) =>
      targets.push({ to: entry.to, pointer: ["nodes", id, "catch", index] }),
    );
  }
  return targets;
}

function checkNodeShapes(ctx: ValidationContext): void {
  const { document, steps, errors } = ctx;
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.kind === "step" && steps[node.step] === undefined) {
      const suggestion = closest(node.step, Object.keys(steps));
      errors.push({
        code: "unknown_step",
        path: jsonPointer(["nodes", id, "step"]),
        message: `No step definition "${node.step}"`,
        hint:
          suggestion === undefined
            ? "Push the step definition first, or fix the key"
            : `Did you mean "${suggestion}"?`,
      });
    }
    if (
      node.kind === "step" &&
      node.maxTurns === 0 &&
      steps[node.step]?.resultSchema === null
    ) {
      errors.push({
        code: "conversation_needs_turns",
        path: jsonPointer(["nodes", id, "maxTurns"]),
        message: `"${id}" is a conversation step with "maxTurns" 0, so it could never hand the conversation to a person`,
        hint: 'Raise "maxTurns", or give the step a result schema',
      });
    }
    if (node.kind !== "step" && node.kind !== "wait") {
      continue;
    }
    if (node.next === undefined) {
      continue;
    }
    const { routes, match } = node.next;
    if (match !== "all" && routes.length > 1) {
      routes.forEach((route, index) => {
        if (route.when === undefined) {
          errors.push({
            code: "route_without_when",
            path: jsonPointer(["nodes", id, "next", "routes", index]),
            message: `"${id}" has more than one route, so every route needs a "when"; a route without one is only allowed as the only route`,
            hint: 'Add a "when", or move this target to "otherwise"',
          });
        }
      });
    }
  }
}

function checkWaitErrorNames(
  ctx: ValidationContext,
  id: string,
  node: WaitNode,
): void {
  const known: readonly string[] = WAIT_ERRORS;
  (node.catch ?? []).forEach((entry, index) => {
    entry.on.forEach((name, nameIndex) => {
      if (known.includes(name)) {
        return;
      }
      const suggestion = closest(name, known);
      ctx.errors.push({
        code: "unknown_error_name",
        path: jsonPointer(["nodes", id, "catch", index, "on", nameIndex]),
        message: `A wait node can't raise "${name}"`,
        hint:
          suggestion === undefined
            ? `A wait can only catch ${quoteList(WAIT_ERRORS)}`
            : `Did you mean "${suggestion}"?`,
      });
    });
  });
}

function checkErrorNames(ctx: ValidationContext): void {
  for (const [id, node] of Object.entries(ctx.document.nodes)) {
    if (node.kind === "wait") {
      checkWaitErrorNames(ctx, id, node);
      continue;
    }
    if (node.kind !== "step") {
      continue;
    }
    const declared = ctx.steps[node.step]?.errors;
    const known = [...BUILT_IN_ERRORS, ...(declared ?? [])];
    const check = (
      list: "retry" | "catch",
      entries: StepNode["retry"] | StepNode["catch"],
    ) => {
      (entries ?? []).forEach((entry, index) => {
        entry.on.forEach((name, nameIndex) => {
          if (declared === undefined || known.includes(name)) {
            return;
          }
          const suggestion = closest(name, known);
          ctx.errors.push({
            code: "unknown_error_name",
            path: jsonPointer(["nodes", id, list, index, "on", nameIndex]),
            message: `Step "${node.step}" doesn't declare an error "${name}"`,
            hint:
              suggestion === undefined
                ? `Use a built-in error (${quoteList(BUILT_IN_ERRORS)}) or one the step declares${declared.length > 0 ? ` (${quoteList(declared)})` : ""}`
                : `Did you mean "${suggestion}"?`,
          });
        });
      });
    };
    check("retry", node.retry);
    check("catch", node.catch);
  }
}

function checkUnreachable(ctx: ValidationContext): void {
  const reachable = reachableFrom(ctx.graph, [null]);
  for (const id of Object.keys(ctx.document.nodes)) {
    if (!reachable.has(id)) {
      ctx.errors.push({
        code: "unreachable_node",
        path: jsonPointer(["nodes", id]),
        message: `"${id}" can't be reached from "start"`,
        hint: "Add a transition to it, or remove it",
      });
    }
  }
}

function checkEach(ctx: ValidationContext, edge: Edge): void {
  const transition = transitionOf(ctx, edge) as Route;
  if (transition.each === undefined) {
    return;
  }
  const pointer = [...edge.pointer, "each", "over"];
  if (edge.kind === "start") {
    ctx.errors.push({
      code: "split",
      path: jsonPointer([...edge.pointer, "each"]),
      message: 'The start transition can\'t use "each"',
      hint: "Start lanes from the first step's next",
    });
    return;
  }
  const schema = resolveReferenceSchema(
    ctx,
    siteFor(ctx, edge, "over"),
    transition.each.over,
    pointer,
  );
  if (schema !== null && !onlyTypes(withoutNull(schema), ["array"])) {
    ctx.errors.push({
      code: "type_mismatch",
      path: jsonPointer(pointer),
      message: `"each.over" must be an array, but "${transition.each.over}" is ${describeSchema(schema)}`,
    });
  }
}

/**
 * A merge's input is built from its partial routes: every required field
 * must arrive, and fields from item lanes must be arrays (they're
 * concatenated in item order).
 */
function checkMergeFields(ctx: ValidationContext, merge: Merge): void {
  const node = ctx.document.nodes[merge.nodeId];
  if (node?.kind !== "step" || ctx.steps[node.step] === undefined) {
    return;
  }
  const input = inputSchemaOf(ctx, merge.nodeId);
  for (const field of merge.fields.values()) {
    const expected = schemaAtPath(input, [field.name]);
    if (
      !field.fromEach ||
      expected === null ||
      isAnySchema(expected) ||
      allowsType(expected, "array")
    ) {
      continue;
    }
    for (const edge of field.edges) {
      ctx.errors.push({
        code: "split",
        path: jsonPointer([...edge.pointer, "args", field.name]),
        message: `"${field.name}" is supplied from item lanes, so "${merge.nodeId}" must take it as an array (the lanes' values are concatenated), but it's ${describeSchema(expected)}`,
        hint: `Make "${field.name}" an array in the step's input`,
      });
    }
  }
  const { schema } = deref(input);
  const required = typeof schema === "object" ? (schema.required ?? []) : [];
  for (const name of required) {
    const field = merge.fields.get(name);
    if (field?.guaranteed === true) {
      continue;
    }
    const at = merge.incoming[0]?.pointer ?? ["nodes", merge.nodeId];
    ctx.errors.push({
      code: "missing_arg",
      path: jsonPointer([...at, "args", name]),
      message:
        field === undefined
          ? `"${merge.nodeId}" requires "${name}", but no "partial" route into it supplies it`
          : `"${merge.nodeId}" requires "${name}", but it might not arrive`,
      hint: `Make "${name}" optional, or supply it on every path`,
    });
  }
}

/** Validates a pipeline document against the step contracts it uses. */
export function validatePipeline(
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses an untrusted document at the boundary
  input: unknown,
  steps: StepCatalog,
): ValidationResult {
  const parsed = parseDocument(input);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  const { document } = parsed;
  const errors: ValidationError[] = [
    ...checkNotInV1(document),
    ...checkDecisionActions(document),
    ...checkTargets(document, allTargets(document)),
  ];
  const graph = buildGraph(document);
  const splits = analyzeSplits(graph);
  errors.push(...splits.errors);
  const ctx: ValidationContext = {
    document,
    steps,
    graph,
    splits,
    errors,
    reachBacks: [],
    waitInputs: new Map(),
  };
  checkNodeShapes(ctx);
  checkUnreachable(ctx);
  checkErrorNames(ctx);
  for (const edge of graph.edges) {
    checkEach(ctx, edge);
    const transition = transitionOf(ctx, edge);
    if ("when" in transition && transition.when !== undefined) {
      checkCondition(ctx, siteFor(ctx, edge, "when"), transition.when, [
        ...edge.pointer,
        "when",
      ]);
    }
    checkArgs(ctx, edge);
  }
  for (const merge of splits.merges.values()) {
    checkMergeFields(ctx, merge);
  }
  errors.push(...checkReachBacks(graph, splits.scopes, ctx.reachBacks));
  const unique = dedupe(errors);
  return unique.length === 0
    ? { ok: true, document, errors: [] }
    : { ok: false, document, errors: unique };
}

function dedupe(errors: ValidationError[]): ValidationError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.path}\u0000${error.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
