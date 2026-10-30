/**
 * `definePipeline`: runs the authoring callbacks once, with placeholders, and
 * compiles the result to a pipeline JSON document. It doesn't validate the
 * document (that's `validatePipeline` in `@scarn/shared-core/pipelines`);
 * it reports what only the TS source can show, and throws
 * `PipelineBuildError` when anything is wrong.
 */
import type {
  PipelineDocument,
  StepCatalog,
} from "../contracts/pipeline-document";
import { compileTransition, wireChain } from "./compile-chain";
import {
  checkDecisionActions,
  checkReachable,
  checkReaches,
  checkUnusedReads,
  unusedChainWarnings,
  workItemFields,
} from "./compile-checks";
import { newState, type CompileState, type PlacedNode } from "./compile-state";
import { PipelineBuildError, type BuildIssue } from "./errors";
import { withTracker } from "./refs";
import { captureSite, type SourceSite } from "./source";
import type { FlowChain, Target } from "./types";

export interface PipelineConfig {
  key: string;
  title?: string;
  /** The first node. Only `workItem.*` refs and literals are available here. */
  start: Target;
  flow: readonly FlowChain[];
}

/** What `definePipeline` returns: the compiled document and what the build needs. */
export interface PipelineDefinition {
  readonly _tag: "pipeline_document";
  readonly key: string;
  readonly document: PipelineDocument;
  /** TS source sites by JSON pointer (`/nodes/fix/next/routes/0`), for error messages. */
  readonly sourceMap: Readonly<Record<string, SourceSite>>;
  /** The local steps' contracts, by step key. `stepRef` steps aren't in it. */
  readonly steps: StepCatalog;
  /** Problems that don't stop the build, such as chains left out of `flow`. */
  readonly warnings: readonly BuildIssue[];
}

function nodeJson(placed: PlacedNode): Record<string, unknown> {
  const def = placed.def;
  const settings = placed.chain?.settings ?? {};
  const title = settings.title ?? ("title" in def ? def.title : undefined);
  const head: Record<string, unknown> = { kind: def.kind };
  if (title !== undefined) {
    head["title"] = title;
  }
  if (def.kind === "step") {
    head["step"] = def.step;
  } else if (def.kind === "wait") {
    head["for"] = def.for;
    if (def.actions !== null) {
      head["actions"] = def.actions.map((action) => ({ ...action }));
    }
  } else if (def.kind === "fail") {
    if (def.error !== undefined) head["error"] = def.error;
    if (def.cause !== undefined) head["cause"] = def.cause;
  }
  for (const [key, value] of Object.entries(settings)) {
    if (key !== "title" && value !== undefined) {
      head[key] = value;
    }
  }
  return { ...head, ...placed.json };
}

/**
 * Steps and waits in the order they're first reached, then terminals in the
 * order their handles were created, so declaring terminals up front controls
 * where they appear.
 */
function orderedNodes(state: CompileState): [string, PlacedNode][] {
  const entries = [...state.nodes];
  const seq = ([, placed]: [string, PlacedNode]) =>
    placed.def.kind === "succeed" || placed.def.kind === "fail"
      ? placed.def.seq
      : -1;
  return [
    ...entries.filter((entry) => seq(entry) < 0),
    ...entries
      .filter((entry) => seq(entry) >= 0)
      .sort((a, b) => seq(a) - seq(b)),
  ];
}

function stepCatalog(state: CompileState): StepCatalog {
  const steps: Record<string, StepCatalog[string]> = {};
  for (const { def } of state.nodes.values()) {
    if (def.kind === "step" && def.local) {
      steps[def.step] = {
        inputSchema: def.inputSchema ?? true,
        resultSchema: def.conversation ? null : (def.resultSchema ?? true),
        errors: [...def.errors],
      };
    }
  }
  return steps;
}

function compile(
  config: PipelineConfig,
  site: SourceSite | null,
): PipelineDefinition {
  const state = newState();
  const start = withTracker(state.tracker, () => {
    const transition = compileTransition(
      state,
      config.start,
      null,
      ["start"],
      site,
      "start",
    );
    for (const chain of config.flow) {
      wireChain(state, chain, site);
    }
    return transition;
  });
  checkReachable(
    state,
    typeof start?.["to"] === "string" ? start["to"] : undefined,
  );
  checkDecisionActions(state);
  checkReaches(state);
  checkUnusedReads(state);
  const fields = workItemFields(state);
  const warnings = unusedChainWarnings(state);
  if (state.issues.length > 0 || start === undefined) {
    throw new PipelineBuildError(config.key, state.issues);
  }
  const nodes: Record<string, unknown> = {};
  for (const [id, placed] of orderedNodes(state)) {
    nodes[id] = nodeJson(placed);
  }
  const document = {
    schemaVersion: 1,
    key: config.key,
    ...(config.title === undefined ? {} : { title: config.title }),
    ...(fields === undefined ? {} : { workItemFields: fields }),
    start,
    nodes,
  } as PipelineDocument;
  return {
    _tag: "pipeline_document",
    key: config.key,
    document,
    sourceMap: {
      "": site ?? { file: "<unknown>", line: 0, column: 0 },
      ...state.sourceMap,
    },
    steps: stepCatalog(state),
    warnings,
  };
}

/** Compiles a pipeline to its JSON document. Throws `PipelineBuildError`. */
export function definePipeline(config: PipelineConfig): PipelineDefinition {
  return compile(config, captureSite());
}
