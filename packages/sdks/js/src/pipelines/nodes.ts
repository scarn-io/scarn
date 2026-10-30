/**
 * Nodes that aren't step definitions: `decision` and `reply` waits, the
 * `succeed` / `fail` terminals, `stepRef` for server-only steps, and the
 * work-item references.
 */
import { toJSONSchema, type $ZodType } from "zod/v4/core";
import {
  decisionResultSchema,
  REPLY_INPUT_SCHEMA,
  REPLY_RESULT_SCHEMA,
  type DecisionAction,
  type DecisionBody,
  type JsonSchema,
} from "../contracts/pipeline-document";
import { bareStepHandle, waitHandle } from "./handles";
import { registerNode, registerTarget } from "./registry";
import { rootPlaceholder } from "./refs";
import type { Placeholder, UntypedPlaceholder } from "./ref-types";
import { captureSite } from "./source";
import type {
  DecisionResult,
  PipelineStep,
  ReplyInput,
  ReplyResult,
  Terminal,
  WaitHandle,
} from "./types";

/** A zod schema, typed by its output. */
interface Schema<T> {
  readonly _output: T;
}

function inputSchemaJson<I>(input: Schema<I> | undefined): JsonSchema | null {
  return input === undefined
    ? null
    : (toJSONSchema(input as unknown as $ZodType) as Record<string, unknown>);
}

/** One action of a `decision` wait: its button label, and whether it needs a body. */
export interface DecisionActionOptions {
  label: string;
  /** Defaults to `"optional"`. */
  body?: DecisionBody;
}

/**
 * A wait for a decision: the person picks one of `actions` (buttons in key
 * order) and can write a body. The result is `{ action, body }`, with
 * `action` one of the keys of `actions`. `input` is what's being decided
 * about; it types the args and `r.input`.
 */
export function decision<
  I = Record<string, unknown>,
  const A extends Record<string, DecisionActionOptions> = Record<
    string,
    DecisionActionOptions
  >,
>(
  id: string,
  options: { input?: Schema<I>; actions: A },
): WaitHandle<I, DecisionResult<Extract<keyof A, string>>> {
  const actions: DecisionAction[] = Object.entries(options.actions).map(
    ([key, action]) => ({
      key,
      label: action.label,
      body: action.body ?? "optional",
    }),
  );
  return waitHandle({
    kind: "wait",
    id,
    for: "decision",
    actions,
    inputSchema: inputSchemaJson(options.input),
    resultSchema: decisionResultSchema(actions),
    site: captureSite(),
  }) as WaitHandle<I, DecisionResult<Extract<keyof A, string>>>;
}

/**
 * A wait for a reply to questions posted on the work item. Every transition
 * into it passes `questions: string[]`; `{ questions: [] }` asks the default
 * question.
 */
export function reply(id: string): WaitHandle<ReplyInput, ReplyResult> {
  return waitHandle({
    kind: "wait",
    id,
    for: "reply",
    actions: null,
    inputSchema: {
      type: "object",
      properties: { questions: REPLY_INPUT_SCHEMA },
      required: ["questions"],
    },
    resultSchema: REPLY_RESULT_SCHEMA,
    site: captureSite(),
  }) as WaitHandle<ReplyInput, ReplyResult>;
}

let terminalSeq = 0;

function terminal(node: Parameters<typeof registerNode>[1]): Terminal {
  const value = Object.freeze({ _tag: "pipeline_target", to: node.id });
  registerNode(value, node);
  return registerTarget(value, {
    node,
    args: undefined,
    site: node.site,
  }) as unknown as Terminal;
}

/** Ends the run (or, inside a lane, that lane) successfully. */
export function succeed(
  id: string,
  options: { title?: string } = {},
): Terminal {
  return terminal({
    kind: "succeed",
    id,
    seq: terminalSeq++,
    ...(options.title === undefined ? {} : { title: options.title }),
    site: captureSite(),
  });
}

/** Ends the run (or, inside a lane, that lane) as failed. */
export function fail(
  id: string,
  options: { error?: string; cause?: string; title?: string } = {},
): Terminal {
  return terminal({
    kind: "fail",
    id,
    seq: terminalSeq++,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    site: captureSite(),
  });
}

/**
 * A step that exists only on the server. Untyped unless you pass type
 * arguments; the build validates it against the server catalog.
 */
export function stepRef<
  TInput = unknown,
  TResult = unknown,
  TErrors extends string = string,
>(key: string): PipelineStep<TInput, TResult, TErrors> {
  return bareStepHandle(
    { key, inputSchemaJson: null, resultSchemaJson: null, errors: [] },
    false,
  ) as unknown as PipelineStep<TInput, TResult, TErrors>;
}

/** Work-item data, readable anywhere. */
export const workItem: {
  readonly title: Placeholder<string>;
  readonly description: Placeholder<string | null>;
} = {
  get title() {
    return rootPlaceholder("workItem.title", {
      type: "string",
    }) as Placeholder<string>;
  },
  get description() {
    return rootPlaceholder("workItem.description", {
      type: ["string", "null"],
    }) as Placeholder<string | null>;
  },
};

/**
 * A work-item form field, as `workItem.fields.<alias>`. `label` is the form
 * label it's read from; the pipeline's `workItemFields` collects them.
 */
export function workItemField(
  alias: string,
  label: string,
): UntypedPlaceholder {
  return rootPlaceholder(`workItem.fields.${alias}`, undefined, {
    field: { alias, label },
  }) as UntypedPlaceholder;
}
