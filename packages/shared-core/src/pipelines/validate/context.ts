/**
 * Shared validator state: the context passed through every check, use sites
 * (which references a transition may use), and the input and result schemas
 * of each node.
 */
import {
  CONVERSATION_RESULT_SCHEMA,
  decisionResultSchema,
  REPLY_RESULT_SCHEMA,
  type Catch,
  type JsonSchema,
  type JsonValue,
  type ListArg,
  type PipelineDocument,
  routeAt,
  type Otherwise,
  type Route,
  type StepCatalog,
} from "@scarn/sdk/contracts/pipeline-document";
import type { ReferenceKind } from "../references/parse";
import type { Edge, PipelineGraph, ReachBack } from "./graph";
import {
  ANY,
  arrayOf,
  inline,
  itemsSchema,
  rooted,
  unionOf,
  type RootedSchema,
} from "./json-schema";
import { resolveReferenceSchema } from "./reference-schema";
import type { SplitAnalysis } from "./splits";
import type { ValidationError } from "./types";

export interface ValidationContext {
  document: PipelineDocument;
  steps: StepCatalog;
  graph: PipelineGraph;
  splits: SplitAnalysis;
  errors: ValidationError[];
  reachBacks: ReachBack[];
  waitInputs: Map<string, RootedSchema | "pending">;
}

/** Where a reference is used: which node's transition, and what it may refer to. */
export interface Site {
  sourceId: string | null;
  kind: "start" | "route" | "otherwise" | "catch";
  allowed: ReadonlySet<ReferenceKind>;
  /** The splits whose lanes the site is evaluated in, outermost first. */
  useScope: readonly string[];
  item?: RootedSchema;
  /** Silent sites resolve types without reporting errors or recording reach-backs. */
  silent?: boolean;
}

export type SitePart = "args" | "when" | "over";

export function report(
  ctx: ValidationContext,
  site: Site,
  error: ValidationError,
): void {
  if (site.silent !== true) {
    ctx.errors.push(error);
  }
}

export function scopeOf(
  ctx: ValidationContext,
  nodeId: string | null,
): readonly string[] {
  return nodeId === null ? [] : (ctx.splits.scopes.get(nodeId) ?? []);
}

export function transitionOf(
  ctx: ValidationContext,
  edge: Edge,
): Route | Otherwise | Catch {
  if (edge.from === null) {
    return ctx.document.start;
  }
  const node = ctx.document.nodes[edge.from];
  if (
    (node?.kind === "step" || node?.kind === "wait") &&
    edge.kind === "catch"
  ) {
    return node.catch?.[edge.index] as Catch;
  }
  return (
    (node?.kind === "step" || node?.kind === "wait") &&
    (edge.kind === "route" || edge.kind === "otherwise")
      ? routeAt(node.next, edge.kind, edge.index)
      : undefined
  ) as Route;
}

export function siteFor(
  ctx: ValidationContext,
  edge: Edge,
  part: SitePart,
  silent = false,
): Site {
  const scope = scopeOf(ctx, edge.from);
  if (edge.kind === "start") {
    return {
      sourceId: null,
      kind: "start",
      allowed: new Set(["workItemTitle", "workItemField"]),
      useScope: [],
      silent,
    };
  }
  if (edge.kind === "catch") {
    return {
      sourceId: edge.from,
      kind: "catch",
      allowed: new Set([
        "input",
        "error",
        "node",
        "workItemTitle",
        "workItemField",
      ]),
      useScope: scope,
      silent,
    };
  }
  const allowed = new Set<ReferenceKind>([
    "result",
    "input",
    "node",
    "workItemTitle",
    "workItemField",
  ]);
  const site: Site = {
    sourceId: edge.from,
    kind: edge.kind,
    allowed,
    useScope: scope,
    silent,
  };
  if (edge.lane === "each" && part === "args") {
    allowed.add("item");
    const transition = transitionOf(ctx, edge) as Route;
    const over = transition.each?.over;
    const overSchema =
      over === undefined
        ? null
        : resolveReferenceSchema(
            ctx,
            siteFor(ctx, edge, "over", true),
            over,
            [],
          );
    site.item = overSchema === null ? ANY : itemsSchema(overSchema);
  }
  return site;
}

export function resultSchemaOf(
  ctx: ValidationContext,
  nodeId: string,
): RootedSchema {
  const node = ctx.document.nodes[nodeId];
  if (node?.kind === "wait") {
    if (node.for === "decision") {
      return rooted(decisionResultSchema(node.actions ?? []));
    }
    if (node.for === "reply") {
      return rooted(REPLY_RESULT_SCHEMA);
    }
    return ANY;
  }
  if (node?.kind === "step") {
    const contract = ctx.steps[node.step];
    if (contract === undefined) {
      return ANY;
    }
    return rooted(contract.resultSchema ?? CONVERSATION_RESULT_SCHEMA);
  }
  return ANY;
}

export function inputSchemaOf(
  ctx: ValidationContext,
  nodeId: string,
): RootedSchema {
  const node = ctx.document.nodes[nodeId];
  if (node?.kind === "wait") {
    return waitInputSchema(ctx, nodeId);
  }
  if (node?.kind === "step") {
    const contract = ctx.steps[node.step];
    return contract === undefined ? ANY : rooted(contract.inputSchema);
  }
  return ANY;
}

/**
 * A wait node declares no inputs: its input is whatever every incoming
 * transition passes. A field is known only if every transition passes it;
 * its type is the union of what they pass.
 */
function waitInputSchema(ctx: ValidationContext, nodeId: string): RootedSchema {
  const cached = ctx.waitInputs.get(nodeId);
  if (cached === "pending") {
    return ANY;
  }
  if (cached !== undefined) {
    return cached;
  }
  ctx.waitInputs.set(nodeId, "pending");
  const incoming = ctx.graph.incoming.get(nodeId) ?? [];
  const perEdge = incoming.map((edge) => {
    const site = siteFor(ctx, edge, "args", true);
    const fields = new Map<string, RootedSchema>();
    for (const [name, arg] of Object.entries(
      transitionOf(ctx, edge).args ?? {},
    )) {
      fields.set(
        name,
        typeof arg === "string"
          ? (resolveReferenceSchema(ctx, site, arg, []) ?? ANY)
          : "list" in arg
            ? listSchemaOf(ctx, site, arg.list)
            : rooted(literalSchema(arg.value)),
      );
    }
    return fields;
  });
  const names = [...(perEdge[0]?.keys() ?? [])].filter((name) =>
    perEdge.every((fields) => fields.has(name)),
  );
  const properties: Record<string, JsonSchema> = {};
  for (const name of names) {
    properties[name] = inline(
      unionOf(perEdge.map((fields) => fields.get(name) ?? ANY)),
    );
  }
  const schema = rooted({
    type: "object",
    properties,
    required: names,
    additionalProperties: false,
  });
  ctx.waitInputs.set(nodeId, schema);
  return schema;
}

function literalSchema(value: JsonValue): JsonSchema {
  return { const: value };
}

/** The array schema a `{ list }` arg builds. */
export function listSchemaOf(
  ctx: ValidationContext,
  site: Site,
  list: ListArg["list"],
): RootedSchema {
  if (list.length === 0) {
    return arrayOf(ANY);
  }
  const silent: Site = { ...site, silent: true };
  return arrayOf(
    unionOf(
      list.map((element) =>
        typeof element === "string"
          ? (resolveReferenceSchema(ctx, silent, element, []) ?? ANY)
          : rooted(literalSchema(element.value)),
      ),
    ),
  );
}
