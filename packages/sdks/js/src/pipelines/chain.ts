/**
 * Chains at run time. A chain is an immutable value: every method returns a
 * new chain, so wiring a step in one pipeline never changes the step or
 * another pipeline. The type-state lives in `types.ts`; at run time one
 * object carries every method, and misuse the types already prevent (from
 * JS, or through casts) throws.
 */
import { AuthoringError } from "./errors";
import {
  emptyChain,
  type ChainData,
  type NextData,
  type NodeDef,
  type NodeSettings,
  type TargetSpec,
} from "./model";
import { chainOf, eachOf, nodeOf, registerChain, targetOf } from "./registry";
import { captureSite } from "./source";

type When = (r: object) => object;

interface NextOptions {
  match?: string;
  routes?: readonly { when?: When; to?: TargetSpec }[];
  otherwise?: TargetSpec;
}

function next(data: ChainData, change: Partial<ChainData>): object {
  return chainValue({ ...data, ...change, site: captureSite() });
}

function assertOpen(data: ChainData, method: string): void {
  if (data.next !== undefined) {
    throw new AuthoringError(
      `.${method}() can't follow .next(): the chain for "${data.node.id}" is already finished`,
    );
  }
}

function isTargetSpec(value: object): boolean {
  return (
    typeof value === "function" ||
    nodeOf(value) !== undefined ||
    targetOf(value) !== undefined ||
    eachOf(value) !== undefined ||
    chainOf(value) !== undefined
  );
}

function nextData(id: string, arg: object): NextData {
  const site = captureSite();
  if (isTargetSpec(arg) || !("routes" in arg)) {
    return {
      match: undefined,
      routes: [{ when: undefined, target: arg }],
      otherwise: undefined,
      site,
    };
  }
  const options = arg as NextOptions;
  if (
    options.match !== undefined &&
    options.match !== "first" &&
    options.match !== "all"
  ) {
    throw new AuthoringError(
      `.next() for "${id}": match "${options.match}" isn't supported; use "first" or "all"`,
    );
  }
  if (options.routes === undefined || options.routes.length === 0) {
    throw new AuthoringError(
      `.next() for "${id}" needs at least one route in "routes"`,
    );
  }
  const routes = options.routes.map((route, index) => {
    if (route.to === undefined) {
      throw new AuthoringError(
        `.next() for "${id}": route ${String(index)} has no "to"`,
      );
    }
    return { when: route.when, target: route.to };
  });
  return {
    match: options.match === "all" ? "all" : undefined,
    routes,
    otherwise: options.otherwise,
    site,
  };
}

/** The chain methods, closed over one chain's data. */
function chainMethods(data: () => ChainData) {
  return {
    settings: (settings: NodeSettings): object => {
      const current = data();
      assertOpen(current, "settings");
      return next(current, { settings: { ...settings } });
    },
    retry: (options: {
      on: readonly string[];
      maxAttempts: number;
    }): object => {
      const current = data();
      assertOpen(current, "retry");
      if (current.node.kind !== "step") {
        throw new AuthoringError(
          `"${current.node.id}" is a wait and can't retry`,
        );
      }
      return next(current, {
        retry: [
          ...current.retry,
          { on: [...options.on], maxAttempts: options.maxAttempts },
        ],
      });
    },
    catch: (on: readonly string[], target: TargetSpec): object => {
      const current = data();
      assertOpen(current, "catch");
      return next(current, {
        catch: [...current.catch, { on: [...on], target, site: captureSite() }],
      });
    },
    next: (arg: object): object => {
      const current = data();
      assertOpen(current, "next");
      return next(current, { next: nextData(current.node.id, arg) });
    },
  };
}

function chainValue(data: ChainData): object {
  return registerChain(
    Object.freeze({
      _tag: "pipeline_chain",
      node: data.node.id,
      ...chainMethods(() => data),
    }),
    data,
  );
}

const HANDLE_METHODS = ["settings", "retry", "catch", "next"] as const;

/**
 * Puts the chain-starting methods on a handle as non-enumerable properties,
 * so the handle's spec fields (and `toStepSpec`) are unchanged. Each call
 * starts a fresh chain.
 */
export function attachChainMethods(handle: object, node: NodeDef): void {
  const methods = chainMethods(() => emptyChain(node));
  for (const name of HANDLE_METHODS) {
    if (node.kind !== "step" && name === "retry") {
      continue;
    }
    Object.defineProperty(handle, name, {
      value: methods[name],
      enumerable: false,
      configurable: true,
    });
  }
}
