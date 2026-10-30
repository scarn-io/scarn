/**
 * Checks a transition's args against the target node's inputs: none
 * missing, no extras, and every value's type compatible with the input.
 * A `partial` route's args are checked field by field without requiring the
 * fields it leaves out (the merge checks those), and a `{ list }` arg is
 * checked element by element against the input's item schema.
 */
import {
  jsonPointer,
  REPLY_INPUT_SCHEMA,
  type ArgValue,
  type ListArg,
} from "@scarn/sdk/contracts/pipeline-document";
import {
  inputSchemaOf,
  listSchemaOf,
  scopeOf,
  siteFor,
  transitionOf,
  type Site,
  type ValidationContext,
} from "./context";
import { resolveReferenceSchema } from "./reference-schema";
import { dominatorsOf, isPrefix, type Edge, type Segment } from "./graph";
import {
  allowsType,
  deref,
  itemsSchema,
  propertyNames,
  rooted,
  schemaAtPath,
  type RootedSchema,
} from "./json-schema";
import { describeSchema, isAssignable, valueMatches } from "./schema-relations";
import { closest, quoteList } from "./suggest";

type ArgElement = ListArg["list"][number];

function requiredNames(input: RootedSchema): string[] {
  const { schema } = deref(input);
  return typeof schema === "object" ? (schema.required ?? []) : [];
}

function acceptsExtras(input: RootedSchema): boolean {
  const { schema } = deref(input);
  if (typeof schema !== "object") {
    return schema;
  }
  if (schema.properties === undefined) {
    return schema.additionalProperties !== false;
  }
  return (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  );
}

function candidateRefs(
  ctx: ValidationContext,
  site: Site,
  name: string,
): string[] {
  const roots: string[] = [];
  if (site.allowed.has("input")) {
    roots.push("input");
  }
  if (site.allowed.has("result")) {
    roots.push("result");
  }
  if (site.allowed.has("item")) {
    roots.push("item");
  }
  if (site.sourceId !== null) {
    for (const id of [
      site.sourceId,
      ...dominatorsOf(ctx.graph, site.sourceId).reverse(),
    ]) {
      const kind = ctx.document.nodes[id]?.kind;
      const sameLane = isPrefix(scopeOf(ctx, id), site.useScope);
      if (
        id !== site.sourceId &&
        sameLane &&
        (kind === "step" || kind === "wait")
      ) {
        roots.push(`nodes.${id}.result`, `nodes.${id}.input`);
      }
    }
  }
  const named = roots.map((root) => `${root}.${name}`);
  return [
    ...named,
    ...roots.filter((root) => root !== "input" && !root.endsWith(".input")),
  ];
}

/** Suggests a reference available at the site whose type fits the input, for "missing" and "type" hints. */
function suggestRef(
  ctx: ValidationContext,
  site: Site,
  name: string,
  target: RootedSchema,
  exclude?: string,
): string | undefined {
  const silent: Site = { ...site, silent: true };
  return candidateRefs(ctx, site, name).find((ref) => {
    if (ref === exclude) {
      return false;
    }
    const schema = resolveReferenceSchema(ctx, silent, ref, []);
    return schema !== null && isAssignable(schema, target);
  });
}

function describeArg(arg: string | ListArg): string {
  return typeof arg === "string" ? `"${arg}"` : "The list";
}

function targetLabel(ctx: ValidationContext, to: string): string {
  const node = ctx.document.nodes[to];
  return node?.kind === "step" && node.step !== to
    ? `"${to}" (step "${node.step}")`
    : `"${to}"`;
}

/**
 * Every transition into a `reply` wait passes `questions: string[]`, so the
 * wait's inferred input always has it.
 */
function checkReplyQuestions(
  ctx: ValidationContext,
  waitId: string,
  args: Record<string, ArgValue>,
  resolved: ReadonlyMap<string, RootedSchema | null>,
  pointer: Segment[],
): void {
  const expected = rooted(REPLY_INPUT_SCHEMA);
  const arg = args["questions"];
  const at = [...pointer, "questions"];
  if (arg === undefined) {
    ctx.errors.push({
      code: "missing_arg",
      path: jsonPointer(at),
      message: `missing; reply wait "${waitId}" requires questions (string[])`,
      hint: 'Pass the questions to ask, for example "result.missingDetails", or { "value": [] } for the default question',
    });
    return;
  }
  if (typeof arg !== "string" && "value" in arg) {
    if (!valueMatches(arg.value, expected)) {
      ctx.errors.push({
        code: "type_mismatch",
        path: jsonPointer([...at, "value"]),
        message: `${JSON.stringify(arg.value)} doesn't fit "questions" (string[])`,
      });
    }
    return;
  }
  const source = resolved.get("questions") ?? null;
  if (source !== null && !isAssignable(source, expected)) {
    ctx.errors.push({
      code: "type_mismatch",
      path: jsonPointer(at),
      message: `${describeArg(arg)} is ${describeSchema(source)}, but reply wait "${waitId}" needs "questions" to be string[]`,
    });
  }
}

export function checkArgs(ctx: ValidationContext, edge: Edge): void {
  const transition = transitionOf(ctx, edge);
  const args = transition.args ?? {};
  const pointer = [...edge.pointer, "args"];
  const target = ctx.document.nodes[edge.to];
  if (target === undefined) {
    return;
  }
  const site = siteFor(ctx, edge, "args");
  if (target.kind === "succeed" || target.kind === "fail") {
    for (const name of Object.keys(args)) {
      ctx.errors.push({
        code: "extra_arg",
        path: jsonPointer([...pointer, name]),
        message: `"${edge.to}" is a ${target.kind} node and takes no args`,
        hint: `Remove "${name}"`,
      });
    }
    return;
  }
  if (target.kind === "wait") {
    const resolved = new Map<string, RootedSchema | null>();
    for (const [name, arg] of Object.entries(args)) {
      if (typeof arg === "string") {
        resolved.set(
          name,
          resolveReferenceSchema(ctx, site, arg, [...pointer, name]),
        );
      } else if ("list" in arg) {
        checkList(ctx, site, arg.list, rooted(true), name, edge.to, [
          ...pointer,
          name,
        ]);
        resolved.set(name, listSchemaOf(ctx, site, arg.list));
      }
    }
    if (target.for === "reply") {
      checkReplyQuestions(ctx, edge.to, args, resolved, pointer);
    }
    return;
  }
  if (ctx.steps[target.step] === undefined) {
    return;
  }
  const input = inputSchemaOf(ctx, edge.to);
  const declared = propertyNames(input);
  const extrasAllowed = acceptsExtras(input);
  for (const [name, arg] of Object.entries(args)) {
    const at = [...pointer, name];
    const expected = schemaAtPath(input, [name]);
    if (!declared.includes(name) && !extrasAllowed) {
      const suggestion = closest(
        name,
        declared.filter((option) => !(option in args)),
      );
      ctx.errors.push({
        code: "extra_arg",
        path: jsonPointer(at),
        message: `${targetLabel(ctx, edge.to)} has no input "${name}"`,
        hint:
          suggestion !== undefined
            ? `Did you mean "${suggestion}"?`
            : declared.length > 0
              ? `Its inputs are ${quoteList(declared)}`
              : "It takes no inputs; remove the arg",
      });
      if (typeof arg === "string") {
        resolveReferenceSchema(ctx, site, arg, at);
      } else if ("list" in arg) {
        checkList(ctx, site, arg.list, rooted(true), name, edge.to, at);
      }
      continue;
    }
    const targetSchema = expected ?? rooted(true);
    if (typeof arg !== "string" && "list" in arg) {
      if (!allowsType(targetSchema, "array")) {
        ctx.errors.push({
          code: "type_mismatch",
          path: jsonPointer(at),
          message: `A list doesn't fit "${name}" (${describeSchema(targetSchema)})`,
        });
      }
      checkList(
        ctx,
        site,
        arg.list,
        itemsSchema(targetSchema),
        name,
        edge.to,
        at,
      );
      continue;
    }
    if (typeof arg !== "string") {
      if (!valueMatches(arg.value, targetSchema)) {
        ctx.errors.push({
          code: "type_mismatch",
          path: jsonPointer([...at, "value"]),
          message: `${JSON.stringify(arg.value)} doesn't fit "${name}" (${describeSchema(targetSchema)})`,
        });
      }
      continue;
    }
    const source = resolveReferenceSchema(ctx, site, arg, at);
    if (source !== null && !isAssignable(source, targetSchema)) {
      const suggestion = suggestRef(ctx, site, name, targetSchema, arg);
      ctx.errors.push({
        code: "type_mismatch",
        path: jsonPointer(at),
        message: `"${arg}" is ${describeSchema(source)}, but ${targetLabel(ctx, edge.to)} needs "${name}" to be ${describeSchema(targetSchema)}`,
        ...(suggestion === undefined
          ? {}
          : { hint: `Did you mean "${suggestion}"?` }),
      });
    }
  }
  if ("partial" in transition && transition.partial === true) {
    return;
  }
  for (const name of requiredNames(input)) {
    if (Object.hasOwn(args, name)) {
      continue;
    }
    const expected = schemaAtPath(input, [name]) ?? rooted(true);
    const suggestion = suggestRef(ctx, site, name, expected);
    ctx.errors.push({
      code: "missing_arg",
      path: jsonPointer([...pointer, name]),
      message: `missing; ${targetLabel(ctx, edge.to)} requires ${name} (${describeSchema(expected)})`,
      ...(suggestion === undefined
        ? {}
        : { hint: `Did you mean "${suggestion}"?` }),
    });
  }
}

function checkList(
  ctx: ValidationContext,
  site: Site,
  list: readonly ArgElement[],
  item: RootedSchema,
  name: string,
  to: string,
  pointer: Segment[],
): void {
  list.forEach((element, index) => {
    const at = [...pointer, "list", index];
    if (typeof element !== "string") {
      if (!valueMatches(element.value, item)) {
        ctx.errors.push({
          code: "type_mismatch",
          path: jsonPointer([...at, "value"]),
          message: `${JSON.stringify(element.value)} doesn't fit an element of "${name}" (${describeSchema(item)})`,
        });
      }
      return;
    }
    const source = resolveReferenceSchema(ctx, site, element, at);
    if (source !== null && !isAssignable(source, item)) {
      ctx.errors.push({
        code: "type_mismatch",
        path: jsonPointer(at),
        message: `"${element}" is ${describeSchema(source)}, but ${targetLabel(ctx, to)} needs each element of "${name}" to be ${describeSchema(item)}`,
      });
    }
  });
}
