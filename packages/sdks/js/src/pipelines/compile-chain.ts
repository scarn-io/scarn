/**
 * Compiles targets and chains into transitions. `each` targets compile to an
 * `each` route to the lane's start, and `.partial(...)` targets to a
 * `partial` route; which nodes run in lanes is worked out by shared-core's
 * split analysis.
 */
import type { ArgValue, JsonSchema } from "../contracts/pipeline-document";
import { compileCondition, conditionData } from "./condition-data";
import { argEntries, compileArg } from "./compile-args";
import {
  attempt,
  issue,
  mapSource,
  place,
  type CompileState,
  type Segment,
} from "./compile-state";
import { makeContext, makeItem } from "./context";
import { AuthoringError } from "./errors";
import type { ChainData, EachData, TargetData, TargetSpec } from "./model";
import { chainOf, eachOf, nodeOf, targetOf } from "./registry";
import { useRef, withOwners } from "./refs";
import type { SourceSite } from "./source";

type Json = Record<string, unknown>;

interface Resolved {
  target?: TargetData;
  each?: EachData;
}

function resolve(spec: TargetSpec, context: object | null): Resolved {
  const node = nodeOf(spec);
  if (node !== undefined && node.kind !== "succeed" && node.kind !== "fail") {
    return { target: { node, args: undefined, site: null } };
  }
  const value =
    typeof spec === "function"
      ? (spec as (r: object | null) => object)(context)
      : spec;
  const target = targetOf(value);
  if (target !== undefined) {
    return { target };
  }
  const bare = nodeOf(value);
  if (bare !== undefined) {
    return { target: { node: bare, args: undefined, site: null } };
  }
  const each = eachOf(value);
  if (each !== undefined) {
    return { each };
  }
  throw new AuthoringError(
    chainOf(value) !== undefined
      ? "a chain isn't a target; put chains in flow and target the step (step(args) or a bare step)"
      : "this isn't a target: call a step with its args, or use a bare step, decision, succeed or fail",
  );
}

function compileArgs(
  state: CompileState,
  target: TargetData,
  owners: readonly object[],
  pointer: readonly Segment[],
): Record<string, ArgValue> | undefined {
  if (target.args === undefined) {
    return undefined;
  }
  const entries = attempt(state, pointer, target.site, () =>
    argEntries(target.args ?? {}),
  );
  const out: Record<string, ArgValue> = {};
  for (const [name, value] of entries ?? []) {
    const compiled = attempt(state, [...pointer, name], target.site, () =>
      withOwners(owners, () => compileArg(name, value)),
    );
    if (compiled !== undefined) {
      out[name] = compiled;
    }
  }
  return out;
}

function itemsOf(schema: JsonSchema | undefined): JsonSchema | undefined {
  return typeof schema === "object" ? schema.items : undefined;
}

function compileEach(
  state: CompileState,
  each: EachData,
  owners: readonly object[],
  pointer: readonly Segment[],
): Json | undefined {
  const over = attempt(state, [...pointer, "each", "over"], each.site, () =>
    withOwners(owners, () => useRef(each.over)),
  );
  const { item, owner } = makeItem(itemsOf(each.over.schema));
  const start = attempt(state, pointer, each.site, () => {
    const value = each.start(item);
    const target = targetOf(value);
    if (target === undefined || target.partial === true) {
      throw new AuthoringError(
        eachOf(value) !== undefined
          ? "an each's start can't be another each; start the lane at a step, and put the nested each in that step's chain"
          : target?.partial === true
            ? "an each's start can't be a .partial(...) target; start the lane at a step"
            : "an each's start must return a target, such as step({ ... })",
        each.site,
      );
    }
    return target;
  });
  if (over === undefined || start === undefined) {
    return undefined;
  }
  const json = targetJson(state, start, [...owners, owner], pointer);
  const options = {
    ...(each.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: each.maxConcurrency }),
    ...(each.toleratedFailures === undefined
      ? {}
      : { toleratedFailures: { ...each.toleratedFailures } }),
  };
  const transition: Json = { to: json["to"], each: { over, ...options } };
  if (json["args"] !== undefined) {
    transition["args"] = json["args"];
  }
  return transition;
}

function targetJson(
  state: CompileState,
  target: TargetData,
  owners: readonly object[],
  pointer: readonly Segment[],
): Json {
  place(state, target.node, target.site, pointer);
  mapSource(state, pointer, target.site);
  const args = compileArgs(state, target, owners, [...pointer, "args"]);
  const json: Json =
    args === undefined ? { to: target.node.id } : { to: target.node.id, args };
  if (target.partial === true) {
    json["partial"] = true;
  }
  return json;
}

/** Compiles one transition (start, `next` entry or `catch` target); undefined on error. */
export function compileTransition(
  state: CompileState,
  spec: TargetSpec,
  context: object | null,
  pointer: readonly Segment[],
  site: SourceSite | null,
  kind: "start" | "next" | "catch",
): Json | undefined {
  const resolved = attempt(state, pointer, site, () =>
    withOwners(context === null ? [] : [context], () => resolve(spec, context)),
  );
  if (resolved === undefined) {
    return undefined;
  }
  const owners = context === null ? [] : [context];
  if (resolved.each !== undefined) {
    if (kind !== "next") {
      issue(
        state,
        resolved.each.site ?? site,
        pointer,
        "each is only valid as a target in .next(...)",
      );
      return undefined;
    }
    return compileEach(state, resolved.each, owners, pointer);
  }
  const target = resolved.target;
  if (target === undefined) {
    return undefined;
  }
  if (target.partial === true && kind !== "next") {
    issue(
      state,
      target.site ?? site,
      pointer,
      ".partial(...) is only valid as a target in .next(...)",
    );
    return undefined;
  }
  return targetJson(
    state,
    { ...target, site: target.site ?? site },
    owners,
    pointer,
  );
}

/** Wires a finished chain from `flow`. */
export function wireChain(
  state: CompileState,
  value: object,
  site: SourceSite | null,
): void {
  const chain = chainOf(value);
  if (chain === undefined || chain.next === undefined) {
    issue(
      state,
      site,
      [],
      "flow only takes finished chains (ending in .next(...))",
    );
    return;
  }
  const id = chain.node.id;
  const placed = place(state, chain.node, chain.site, ["nodes", id]);
  if (placed === undefined) {
    return;
  }
  if (placed.chain !== undefined) {
    issue(
      state,
      chain.site,
      ["nodes", id],
      `"${id}" is wired twice: it already has a chain in flow. Give each node one chain`,
    );
    return;
  }
  placed.chain = chain;
  state.usedChains.add(chain);
  wireBody(state, chain, placed.json);
}

function wireBody(state: CompileState, chain: ChainData, json: Json): void {
  const id = chain.node.id;
  if (chain.retry.length > 0) {
    json["retry"] = chain.retry.map((entry) => ({
      on: [...entry.on],
      maxAttempts: entry.maxAttempts,
    }));
  }
  const catches = chain.catch.map((entry, index) => {
    const pointer = ["nodes", id, "catch", index];
    const context = makeContext(chain.node, "catch");
    const target = compileTransition(
      state,
      entry.target,
      context,
      pointer,
      entry.site,
      "catch",
    );
    return { on: [...entry.on], ...target };
  });
  if (catches.length > 0) {
    json["catch"] = catches;
  }
  const next = chain.next;
  if (next === undefined) {
    return;
  }
  const context = makeContext(chain.node, "next");
  const compileRoute = (
    when: ((r: object) => object) | undefined,
    target: TargetSpec,
    pointer: Segment[],
  ): Json => {
    mapSource(state, pointer, next.site);
    const entry: Json = {};
    if (when !== undefined) {
      const compiled = attempt(state, [...pointer, "when"], next.site, () =>
        withOwners([context], () =>
          compileCondition(conditionData(when(context))),
        ),
      );
      if (compiled !== undefined) {
        entry["when"] = compiled;
      }
    }
    const compiled = compileTransition(
      state,
      target,
      context,
      pointer,
      next.site,
      "next",
    );
    return { ...entry, ...compiled };
  };
  const out: Json = {};
  if (next.match === "all") {
    out["match"] = "all";
  } else if (next.routes.length > 1) {
    next.routes.forEach((route, index) => {
      if (route.when === undefined) {
        issue(
          state,
          next.site,
          ["nodes", id, "next", "routes", index],
          `"${id}" has more than one route, so in "first" mode every route needs a "when"; move this target to "otherwise", or use match: "all"`,
        );
      }
    });
  }
  out["routes"] = next.routes.map((route, index) =>
    compileRoute(route.when, route.target, [
      "nodes",
      id,
      "next",
      "routes",
      index,
    ]),
  );
  if (next.otherwise !== undefined) {
    out["otherwise"] = compileRoute(undefined, next.otherwise, [
      "nodes",
      id,
      "next",
      "otherwise",
    ]);
  }
  json["next"] = out;
}
