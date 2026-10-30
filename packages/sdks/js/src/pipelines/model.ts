/**
 * The run-time data behind handles, targets and chains. Every value is
 * immutable once created; chain methods return new chains.
 */
import type {
  DecisionAction,
  JsonSchema,
  ToleratedFailures,
} from "../contracts/pipeline-document";
import type { RefData } from "./refs";
import { captureSite, type SourceSite } from "./source";

/** One node of the document, as described by its handle. */
export type NodeDef =
  | {
      readonly kind: "step";
      readonly id: string;
      readonly step: string;
      /** False for `stepRef` steps, which only the server catalog knows. */
      readonly local: boolean;
      readonly inputSchema: JsonSchema | null;
      readonly resultSchema: JsonSchema | null;
      /** A local agent step with no result schema: its result is `CONVERSATION_RESULT_SCHEMA`. */
      readonly conversation: boolean;
      readonly errors: readonly string[];
      readonly site: SourceSite | null;
    }
  | {
      readonly kind: "wait";
      readonly id: string;
      readonly for: "decision" | "reply";
      /** A decision wait's actions, in button order; null on other waits. */
      readonly actions: readonly DecisionAction[] | null;
      readonly inputSchema: JsonSchema | null;
      readonly resultSchema: JsonSchema;
      readonly site: SourceSite | null;
    }
  | {
      readonly kind: "succeed";
      readonly id: string;
      /** Creation order; terminals are emitted after other nodes, in this order. */
      readonly seq: number;
      readonly title?: string;
      readonly site: SourceSite | null;
    }
  | {
      readonly kind: "fail";
      readonly id: string;
      readonly seq: number;
      readonly title?: string;
      readonly error?: string;
      readonly cause?: string;
      readonly site: SourceSite | null;
    };

/** Author-written args, before compiling: refs and literals by name. */
export type RawArgs = Readonly<
  Record<string, object | string | number | boolean | null | undefined>
>;

export interface EachData {
  readonly over: RefData;
  readonly maxConcurrency: number | undefined;
  readonly toleratedFailures: ToleratedFailures | undefined;
  /** The lane's first target, from the item. */
  readonly start: (item: object) => object;
  readonly site: SourceSite | null;
}

/**
 * "Go to this node with these args", from calling a handle; `partial` when
 * it's from `handle.partial(args)` and ends a lane at a merge.
 */
export interface TargetData {
  readonly node: NodeDef;
  readonly args: RawArgs | undefined;
  readonly site: SourceSite | null;
  readonly partial?: true;
}

export interface NodeSettings {
  title?: string;
  timeoutSeconds?: number;
  heartbeatSeconds?: number;
  maxRuns?: number;
  maxTurns?: number;
}

/** A target as written: a target value, a bare handle, an `each`, or a callback returning one. */
export type TargetSpec = object;

export interface CatchData {
  readonly on: readonly string[];
  readonly target: TargetSpec;
  readonly site: SourceSite | null;
}

export interface RouteData {
  readonly when: ((r: object) => object) | undefined;
  readonly target: TargetSpec;
}

/** The `.next(...)` call: its routes, `otherwise`, and match mode. */
export interface NextData {
  readonly match: "first" | "all" | undefined;
  readonly routes: readonly RouteData[];
  readonly otherwise: TargetSpec | undefined;
  readonly site: SourceSite | null;
}

export interface ChainData {
  readonly node: NodeDef;
  readonly settings: NodeSettings;
  readonly retry: readonly { on: readonly string[]; maxAttempts: number }[];
  readonly catch: readonly CatchData[];
  /** Set once `.next(...)` ends the chain. */
  readonly next: NextData | undefined;
  readonly site: SourceSite | null;
}

export function emptyChain(node: NodeDef): ChainData {
  return {
    node,
    settings: {},
    retry: [],
    catch: [],
    next: undefined,
    site: captureSite(),
  };
}
