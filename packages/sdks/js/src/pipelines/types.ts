/**
 * The public types of handles, targets and chains. Each chain method returns
 * a type that only has the methods allowed next (see the chain grammar in
 * `docs/plans/pipeline-ts-sdk.md`), so an unfinished or misordered chain is
 * a type error rather than a build error.
 */
import type {
  BUILT_IN_ERRORS,
  ToleratedFailures,
  WAIT_ERRORS,
} from "../contracts/pipeline-document";
import type { StepRef } from "../definitions/steps/step-ref";
import type { Condition } from "./condition-data";
import type {
  Args,
  ErrorValue,
  JsonLiteral,
  Placeholder,
  Ref,
} from "./ref-types";

export declare const targetBrand: unique symbol;
export declare const eachBrand: unique symbol;
export declare const partialBrand: unique symbol;
export declare const chainBrand: unique symbol;
export declare const terminalBrand: unique symbol;

export type BuiltInError = (typeof BUILT_IN_ERRORS)[number];
export type WaitError = (typeof WAIT_ERRORS)[number];

/** "Go to this node with these args". */
export interface Target {
  readonly [targetBrand]: true;
}

/** An `each`: start one lane per item. Only valid as a `next` target. */
export interface EachTarget {
  readonly [eachBrand]: true;
}

/**
 * "End this lane by contributing these args to the merge node": from
 * `handle.partial(args)`. Only valid as a `next` target inside a lane.
 */
export interface PartialTarget {
  readonly [partialBrand]: true;
}

/** A finished chain, for a pipeline's `flow`. */
export interface FlowChain {
  readonly [chainBrand]: "flow";
}

type NoKeys = Record<never, never>;

/** The args a node is called with; anything goes when its input is untyped. */
export type CallArgs<I> = unknown extends I
  ? Readonly<Record<string, Ref<unknown> | JsonLiteral>>
  : Args<I>;

/** Calling a handle: args are optional only when the input has no required keys. */
export type Call<I> = NoKeys extends I
  ? (args?: CallArgs<I>) => Target
  : (args: CallArgs<I>) => Target;

/** A bare handle is a target only when its input has no required keys. */
export interface Bare<I> {
  readonly [targetBrand]: NoKeys extends I ? true : false;
}

/** Anything `r.node(...)` can reach back to: a step or wait handle. */
export interface NodeHandle<I, R> {
  readonly __input: I;
  readonly __result: R;
}

export interface NodeValues<I, R> {
  readonly result: Placeholder<R>;
  readonly input: Placeholder<I>;
}

export interface Reach {
  /** An earlier node's values, as `nodes.<id>.result` / `nodes.<id>.input`. */
  node<I, R>(handle: NodeHandle<I, R>): NodeValues<I, R>;
}

/** `r` in the callbacks of `.next(...)`. */
export interface NextContext<I, R> extends Reach, NodeValues<I, R> {}

/** `r` in `.catch`: the error and the input, but no result. */
export interface CatchContext<I> extends Reach {
  readonly error: Placeholder<ErrorValue>;
  readonly input: Placeholder<I>;
}

export type NextTarget = Target | EachTarget | PartialTarget;

/** A target, or a callback receiving `r` that returns one. */
export type TargetArg<C, T> = T | ((r: C) => T);

/** One route of `.next({ routes })`: taken when `when` matches (or always, with no `when`). */
export interface NextRoute<C> {
  when?: (r: C) => Condition;
  to: TargetArg<C, NextTarget>;
}

/**
 * The routes of `.next(...)`. In `"first"` mode (the default) the first
 * matching route is taken; in `"all"` mode every matching route is taken,
 * each as a lane.
 */
export interface NextOptions<C> {
  match?: "first" | "all";
  routes: readonly [NextRoute<C>, ...NextRoute<C>[]];
  /** Taken when no route with a `when` matched. With nothing taken, the path ends there. */
  otherwise?: TargetArg<C, NextTarget>;
}

export interface Routable<C, Out> {
  /** Where to go next: one target, or routes with conditions. Ends the chain. */
  next(target: TargetArg<C, NextTarget> | NextOptions<C>): Out;
}

/** `.partial(args)` on a step or wait handle: a merge target taking some of the node's args. */
export interface Mergeable<I> {
  partial(args: Partial<CallArgs<I>>): PartialTarget;
}

/** The options of `each`. */
export interface EachOptions {
  maxConcurrency?: number;
  /** How many lanes may fail before the run (or enclosing lane) fails. Defaults to `{ count: 0 }`. */
  toleratedFailures?: ToleratedFailures;
}

type ErrorList<E extends string> = readonly [E, ...E[]];

export interface StepSettings {
  title?: string;
  timeoutSeconds?: number;
  heartbeatSeconds?: number;
  maxRuns?: number;
  maxTurns?: number;
}

export interface WaitSettings {
  title?: string;
  maxRuns?: number;
}

export interface RetryOptions<E extends string> {
  on: ErrorList<BuiltInError | E>;
  maxAttempts: number;
}

export interface StepAfterCatch<I, R, E extends string> extends Routable<
  NextContext<I, R>,
  FlowChain
> {
  catch(
    on: ErrorList<BuiltInError | E>,
    target: TargetArg<CatchContext<I>, Target>,
  ): StepAfterCatch<I, R, E>;
}

export interface StepAfterRetry<I, R, E extends string> extends StepAfterCatch<
  I,
  R,
  E
> {
  retry(options: RetryOptions<E>): StepAfterRetry<I, R, E>;
}

export interface StepChain<I, R, E extends string> extends StepAfterRetry<
  I,
  R,
  E
> {
  settings(settings: StepSettings): StepAfterRetry<I, R, E>;
}

/** A step in a pipeline: callable as a target, and the start of its chain. */
export type PipelineStep<I, R, E extends string = string> = Call<I> &
  Bare<I> &
  StepRef<I, R, E> &
  StepChain<I, R, E> &
  Mergeable<I> & {
    /** The same step as a second node, with id `id`. */
    as(id: string): PipelineStep<I, R, E>;
  };

export interface WaitAfterCatch<I, R> extends Routable<
  NextContext<I, R>,
  FlowChain
> {
  catch(
    on: ErrorList<WaitError>,
    target: TargetArg<CatchContext<I>, Target>,
  ): WaitAfterCatch<I, R>;
}

export interface WaitChain<I, R> extends WaitAfterCatch<I, R> {
  settings(settings: WaitSettings): WaitAfterCatch<I, R>;
}

/** A `decision` or `reply` wait node. */
export type WaitHandle<I, R> = Call<I> &
  Bare<I> &
  NodeHandle<I, R> &
  WaitChain<I, R> &
  Mergeable<I>;

/** A `succeed` or `fail` node: a target with no chain. */
export interface Terminal extends Target {
  readonly [terminalBrand]: true;
}

/** The result of a `decision` wait: the chosen action's key, and the person's text or null. */
export interface DecisionResult<K extends string = string> {
  action: K;
  body: string | null;
}

export interface ReplyInput {
  questions: string[];
}

export interface ReplyResult {
  replied: boolean;
  body: string | null;
  commentId: string | null;
}

/** The result of a conversation step: a step with no result schema. */
export interface ConversationResult {
  conversationId: string;
  summary: string;
}
