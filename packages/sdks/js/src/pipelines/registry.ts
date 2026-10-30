/**
 * Links the opaque public values (handles, targets, chains) to their
 * run-time data. The public types carry only brands, so the data lives in
 * these maps, keyed by the value's identity.
 */
import { AuthoringError } from "./errors";
import type { ChainData, EachData, NodeDef, TargetData } from "./model";

const nodes = new WeakMap<object, NodeDef>();
const targets = new WeakMap<object, TargetData>();
const eaches = new WeakMap<object, EachData>();
const chains = new WeakMap<object, ChainData>();

/** Chains finished since the last `definePipeline`, to warn about ones left out of `flow`. */
export const pendingChains = new Set<ChainData>();

export function registerNode<T extends object>(value: T, node: NodeDef): T {
  nodes.set(value, node);
  return value;
}

export function registerTarget<T extends object>(
  value: T,
  target: TargetData,
): T {
  targets.set(value, target);
  return value;
}

export function registerEach<T extends object>(value: T, each: EachData): T {
  eaches.set(value, each);
  return value;
}

export function registerChain<T extends object>(value: T, chain: ChainData): T {
  chains.set(value, chain);
  if (chain.next !== undefined) {
    pendingChains.add(chain);
  }
  return value;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" || typeof value === "function") && value !== null
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function nodeOf(value: unknown): NodeDef | undefined {
  return isObject(value) ? nodes.get(value) : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function targetOf(value: unknown): TargetData | undefined {
  return isObject(value) ? targets.get(value) : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function eachOf(value: unknown): EachData | undefined {
  return isObject(value) ? eaches.get(value) : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function chainOf(value: unknown): ChainData | undefined {
  return isObject(value) ? chains.get(value) : undefined;
}

// eslint-disable-next-line local/no-unknown-parameter-type -- inspects author values
export function requireNode(value: unknown, what: string): NodeDef {
  const node = nodeOf(value);
  if (node === undefined) {
    throw new AuthoringError(
      `${what} must be a step, decision or reply handle`,
    );
  }
  return node;
}
